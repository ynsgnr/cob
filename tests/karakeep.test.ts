import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { getReel, listReels, retry } from "../src/db/reels.ts";
import { karakeepClient, syncOnce, type KarakeepClient, type KkBookmark } from "../src/integrations/karakeep.ts";
import { processReel } from "../src/worker/pipeline.ts";
import { makeDeps } from "./helpers.ts";

const BASE = "https://cob.example";
const opts = { publicBaseUrl: BASE, backfill: false, replace: true };

// In-memory Karakeep: newest first, like the real list endpoint.
function fakeKk(initial: KkBookmark[] = []) {
  const store = [...initial];
  let n = 100;
  const kk: KarakeepClient & { store: KkBookmark[]; removed: string[]; failRemove: boolean } = {
    store, removed: [], failRemove: false,
    async list() { return { bookmarks: [...store].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), nextCursor: null }; },
    async create(url, _t, note) { const id = `new${n++}`; store.push({ id, createdAt: new Date(Date.now() + n).toISOString(), url, note }); return id; },
    async remove(id) { if (kk.failRemove) throw new Error("boom"); kk.removed.push(id); store.splice(store.findIndex((b) => b.id === id), 1); },
  };
  return kk;
}
const future = () => new Date(Date.now() + 60_000).toISOString();
const bm = (id: string, url: string | null, note: string | null = null): KkBookmark => ({ id, createdAt: future(), url, note });

test("a new matching link is archived, replaced by the Cob link, and the original is deleted", async () => {
  const deps = makeDeps();
  const kk = fakeKk();
  await syncOnce(deps, kk, opts); // first run only sets the cutoff
  kk.store.push(bm("b1", "https://example.test/v/k1?utm=1", "my note"), bm("b2", "https://news.example/article"), bm("b3", null));

  await syncOnce(deps, kk, opts);
  const reel = listReels(deps.db)[0]!;
  assert.equal(listReels(deps.db).length, 1); // only the matching link became a reel
  assert.equal(reel.originalUrl, "https://example.test/v/k1?utm=1");
  assert.deepEqual(kk.removed, []); // not done yet: original stays until the reel is archived

  await processReel(deps, reel.id);
  await syncOnce(deps, kk, opts);
  assert.deepEqual(kk.removed, ["b1"]);
  const added = kk.store.find((b) => b.url === `${BASE}/k/${reel.id}`);
  assert.ok(added);
  assert.equal(added.note, "my note");
  assert.ok(kk.store.some((b) => b.id === "b2")); // unrelated links untouched

  await syncOnce(deps, kk, opts); // our own new bookmark is ignored, nothing loops
  assert.equal(listReels(deps.db).length, 1);
  assert.equal(kk.store.length, 3);
});

test("without KARAKEEP_REPLACE the Cob link is added next to the original and nothing is deleted", async () => {
  const deps = makeDeps();
  const kk = fakeKk();
  const keep = { ...opts, replace: false };
  await syncOnce(deps, kk, keep);
  kk.store.push(bm("b1", "https://example.test/v/keep1", "my note"));
  await syncOnce(deps, kk, keep);
  await processReel(deps, listReels(deps.db)[0]!.id);
  await syncOnce(deps, kk, keep);
  await syncOnce(deps, kk, keep); // repeated polls neither delete nor add a second link
  assert.deepEqual(kk.removed, []);
  assert.ok(kk.store.some((b) => b.id === "b1"));
  assert.equal(kk.store.filter((b) => b.url?.startsWith(`${BASE}/k/`)).length, 1);
});

test("links older than the first run are skipped unless backfill is on", async () => {
  const old = { id: "old", createdAt: "2020-01-01T00:00:00.000Z", url: "https://example.test/v/old", note: null };
  const deps = makeDeps();
  await syncOnce(deps, fakeKk([old]), opts);
  assert.equal(listReels(deps.db).length, 0);
  const deps2 = makeDeps();
  await syncOnce(deps2, fakeKk([old]), { ...opts, backfill: true });
  assert.equal(listReels(deps2.db).length, 1);
});

test("a failed download or failed transcript keeps the original", async () => {
  const deps = makeDeps({ transcribe: async () => { throw new Error("down"); } });
  const kk = fakeKk();
  await syncOnce(deps, kk, opts);
  kk.store.push(bm("b1", "https://example.test/v/k2"));
  await syncOnce(deps, kk, opts);
  await processReel(deps, listReels(deps.db)[0]!.id);
  await syncOnce(deps, kk, opts);
  assert.deepEqual(kk.removed, []);
  assert.equal(kk.store.length, 1);

  deps.transcribe = async () => "fixed"; // retry later completes it
  const id = listReels(deps.db)[0]!.id;
  retry(deps.db, id);
  await processReel(deps, id);
  assert.equal(getReel(deps.db, id)!.transcriptStatus, "done");
  await syncOnce(deps, kk, opts);
  assert.deepEqual(kk.removed, ["b1"]);
});

test("a failed delete retries without creating a second bookmark", async () => {
  const deps = makeDeps();
  const kk = fakeKk();
  await syncOnce(deps, kk, opts);
  kk.store.push(bm("b1", "https://example.test/v/k3"));
  await syncOnce(deps, kk, opts);
  await processReel(deps, listReels(deps.db)[0]!.id);
  kk.failRemove = true;
  await syncOnce(deps, kk, opts); // the failure is contained and logged
  assert.deepEqual(kk.removed, []);
  kk.failRemove = false;
  await syncOnce(deps, kk, opts);
  assert.deepEqual(kk.removed, ["b1"]);
  assert.equal(kk.store.filter((b) => b.url?.startsWith(BASE)).length, 1);
});

test("one failing link does not block the next, and a page error does not lose older links", async () => {
  const deps = makeDeps();
  const kk = fakeKk();
  await syncOnce(deps, kk, opts);
  kk.store.push(bm("b1", "https://example.test/v/p1"), bm("b2", "https://example.test/v/p2"));
  await syncOnce(deps, kk, opts);
  for (const r of listReels(deps.db)) await processReel(deps, r.id);
  const realRemove = kk.remove;
  kk.remove = async (id) => { if (id === "b1" || id === "b2") { if (kk.removed.length === 0 && id === "b1") throw new Error("poison"); } return realRemove(id); };
  await syncOnce(deps, kk, opts);
  assert.deepEqual(kk.removed, ["b2"]); // b1 failed, b2 still went through

  // a list failure leaves `since` where it was, so nothing is skipped on the next run
  const deps2 = makeDeps();
  const kk2 = fakeKk();
  await syncOnce(deps2, kk2, opts);
  kk2.store.push(bm("c1", "https://example.test/v/q1"));
  const realList = kk2.list;
  kk2.list = async () => { throw new Error("karakeep down"); };
  await assert.rejects(syncOnce(deps2, kk2, opts), /karakeep down/);
  kk2.list = realList;
  await syncOnce(deps2, kk2, opts);
  assert.equal(listReels(deps2.db).length, 1);
});

test("config: the integration needs the api key, and then the other two vars", () => {
  assert.equal(loadConfig({}).karakeep, null);
  assert.equal(loadConfig({ KARAKEEP_URL: "http://k" }).karakeep, null);
  assert.throws(() => loadConfig({ KARAKEEP_API_KEY: "k" }), /KARAKEEP_URL/);
  assert.deepEqual(loadConfig({ KARAKEEP_API_KEY: "k", KARAKEEP_URL: "http://k/", PUBLIC_BASE_URL: "https://c/" }).karakeep, { url: "http://k", apiKey: "k", publicBaseUrl: "https://c", pollMs: 60000, backfill: false, replace: false });
  assert.equal(loadConfig({ KARAKEEP_API_KEY: "k", KARAKEEP_URL: "http://k", PUBLIC_BASE_URL: "https://c", KARAKEEP_REPLACE: "true" }).karakeep?.replace, true);
  assert.equal(loadConfig({ KARAKEEP_API_KEY: "k", KARAKEEP_URL: "http://k", PUBLIC_BASE_URL: "https://c", KARAKEEP_REPLACE: "yes" }).karakeep?.replace, false); // only the exact word "true" enables deleting
});

test("http client speaks the Karakeep REST API with a bearer key", async () => {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization} ${body}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") res.end(JSON.stringify({ bookmarks: [{ id: "x", createdAt: "2026-01-01T00:00:00Z", note: null, content: { type: "link", url: "https://a/b" } }, { id: "t", createdAt: "2026-01-01T00:00:00Z", content: { type: "text" } }], nextCursor: "x_2026" }));
      else if (req.method === "POST") { res.statusCode = 201; res.end(JSON.stringify({ id: "newid" })); }
      else { res.statusCode = 204; res.end(); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const kk = karakeepClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, "secret");
    const page = await kk.list("cur/1");
    assert.deepEqual(page.bookmarks.map((b) => b.url), ["https://a/b", null]);
    assert.equal(page.nextCursor, "x_2026");
    assert.equal(await kk.create("https://cob/k/1", "T", null), "newid");
    await kk.remove("x");
    assert.match(seen[0]!, /^GET \/api\/v1\/bookmarks\?limit=100&cursor=cur%2F1 Bearer secret/);
    assert.match(seen[1]!, /^POST \/api\/v1\/bookmarks Bearer secret \{"type":"link","url":"https:\/\/cob\/k\/1","title":"T"\}$/);
    assert.match(seen[2]!, /^DELETE \/api\/v1\/bookmarks\/x Bearer secret/);
  } finally { srv.close(); }
});
