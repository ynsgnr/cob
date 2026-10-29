import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { addLink, linksIn } from "../src/db/karakeep.ts";
import { getReel, insertOrGet } from "../src/db/reels.ts";
import { processReel } from "../src/worker/pipeline.ts";
import { createApp } from "../src/web/server.ts";
import { fakeProvider, makeDeps } from "./helpers.ts";

const deps = makeDeps();
const server = createApp(deps);
let base = "";
before(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); })));
after(() => { server.close(); });

const submit = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/reels`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ url }) });

test("submit -> reel url -> page, media with ranges, dedup, search", async () => {
  const res = await submit("https://example.test/v/web1?x=1");
  assert.equal(res.status, 202);
  const { id, url } = (await res.json()) as { id: string; url: string };
  assert.equal(url, `/k/${id}`);

  let page = await (await fetch(`${base}${url}`)).text();
  assert.match(page, /Queued/);

  await processReel(deps, id);
  page = await (await fetch(`${base}${url}`)).text();
  assert.match(page, /Fake title/);
  assert.match(page, /hello world/);
  assert.match(page, /#one/);
  assert.match(page, /<video[^>]+src="\/media\//);
  assert.match(page, /href="https:\/\/example\.test\/v\/web1"/); // clean link shown, tracking params dropped
  assert.doesNotMatch(page, /\?x=1/);

  const full = await fetch(`${base}/media/${id}`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  const part = await fetch(`${base}/media/${id}`, { headers: { range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  assert.equal((await fetch(`${base}/media/${id}`, { headers: { range: "bytes=50-" } })).status, 416);

  const again = await submit("https://example.test/v/web1");
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { id: string }).id, id);

  assert.match(await (await fetch(`${base}/?q=hello`)).text(), /Fake title/);
  assert.doesNotMatch(await (await fetch(`${base}/?q=zzz`)).text(), /Fake title/);
});

test("unsupported links, bad input, cross-origin posts and unknown ids are refused", async () => {
  assert.equal((await submit("https://www.instagram.com/reel/ABC/")).status, 400); // no instagram provider in these deps
  assert.equal((await submit("http://169.254.169.254/latest")).status, 400);
  assert.equal((await fetch(`${base}/api/reels`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status, 400);
  assert.equal((await fetch(`${base}/api/reels`, { method: "POST", body: JSON.stringify({ url: "https://example.test/v/x" }) })).status, 403); // not application/json
  assert.equal((await submit(`https://example.test/v/${"a".repeat(3000)}`)).status, 400);
  assert.equal((await submit("https://example.test/v/x", { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/k/doesnotexist`)).status, 404);
  assert.equal((await fetch(`${base}/media/..%2f..%2fetc%2fpasswd`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("form submit redirects to the reel page and escapes content", async () => {
  const res = await fetch(`${base}/submit`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: "https://example.test/v/form1" }) });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^\/k\/[\w-]+$/);
  const bad = await fetch(`${base}/?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.doesNotMatch(await bad.text(), /<script>alert/);
});

test("a vanished media file gives 404, and a reel with no speech says so", async () => {
  const { reel } = insertOrGet(deps.db, { platform: "fake", externalId: "gone1", originalUrl: "https://example.test/v/gone1", canonicalUrl: "https://example.test/v/gone1" });
  await processReel({ ...deps, transcribe: async () => "" }, reel.id);
  assert.match(await (await fetch(`${base}/k/${reel.id}`)).text(), /No speech detected/);
  rmSync(`${deps.config.mediaDir}/fake/gone1`, { recursive: true });
  assert.equal((await fetch(`${base}/media/${reel.id}`)).status, 404);
});

test("old /r/<id> links redirect to /k/<id>, and every response asks not to be indexed", async () => {
  const old = await fetch(`${base}/r/abc_123`, { redirect: "manual" });
  assert.equal(old.status, 308);
  assert.equal(old.headers.get("location"), "/k/abc_123");
  assert.equal((await fetch(`${base}/r/abc_123/extra`, { redirect: "manual" })).status, 404);
  assert.equal(old.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal((await fetch(`${base}/`)).headers.get("x-robots-tag"), "noindex, nofollow");
});

test("browser POSTs: same-origin passes even when Origin is \"null\" (no-referrer), cross-site and bare null are refused", async () => {
  const post = (headers: Record<string, string>) => fetch(`${base}/k/doesnotexist1/retry`, { method: "POST", redirect: "manual", headers });
  assert.equal((await post({ origin: "null", "sec-fetch-site": "same-origin" })).status, 303); // what a browser sends from a /k page
  assert.equal((await post({ "sec-fetch-site": "same-origin", origin: "https://cob.example" })).status, 303); // proxy changed Host, browser says same-origin
  assert.equal((await post({ "sec-fetch-site": "none" })).status, 303);
  assert.equal((await post({ "sec-fetch-site": "cross-site", origin: base })).status, 403); // header wins over a matching Origin
  assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post({ origin: "null" })).status, 403); // old browser, null origin: refuse
  assert.equal((await post({})).status, 303); // curl and scripts
});

const act = (id: string, action: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/k/${id}/${action}`, { method: "POST", redirect: "manual", headers });
const addReel = (externalId: string) =>
  insertOrGet(deps.db, { platform: "fake", externalId, originalUrl: `https://example.test/v/${externalId}`, canonicalUrl: `https://example.test/v/${externalId}` }).reel;

test("Re-transcribe clears a finished transcript and redoes it with captions or Whisper; Retry shows only when something failed", async () => {
  const reel = addReel("rt1");
  await processReel(deps, reel.id);
  let page = await (await fetch(`${base}/k/${reel.id}`)).text();
  assert.match(page, /Re-transcribe/);
  assert.doesNotMatch(page, />Retry</);

  assert.equal((await act(reel.id, "retranscribe")).status, 303);
  let r = getReel(deps.db, reel.id)!;
  assert.deepEqual([r.status, r.transcript, r.transcriptStatus, r.transcriptSource], ["queued", null, "pending", null]);
  assert.match(await (await fetch(`${base}/k/${reel.id}`)).text(), /Queued/); // no buttons while it is queued

  fakeProvider.subs = { text: "captions found on the second try", auto: true };
  try { await processReel(deps, reel.id); } finally { fakeProvider.subs = undefined; }
  r = getReel(deps.db, reel.id)!;
  assert.deepEqual([r.status, r.transcript, r.transcriptSource], ["done", "captions found on the second try", "auto-captions"]);

  const failing = addReel("rt2");
  await processReel({ ...deps, transcribe: async () => { throw new Error("down"); } }, failing.id);
  page = await (await fetch(`${base}/k/${failing.id}`)).text();
  assert.match(page, />Retry</);
  assert.doesNotMatch(page, /Re-transcribe/);
});

test("Delete removes the entry and its video, only that reel's, and Karakeep will not queue it again", async () => {
  const keep = addReel("keep1");
  const gone = addReel("gone1");
  await processReel(deps, keep.id);
  await processReel(deps, gone.id);
  addLink(deps.db, "bm-1", "waiting", gone.id);
  const dir = (r: { externalId: string }) => `${deps.config.mediaDir}/fake/${r.externalId}`;
  assert.ok(existsSync(dir(gone)));
  assert.match(await (await fetch(`${base}/k/${gone.id}`)).text(), /Delete permanently/);

  assert.equal((await act(gone.id, "delete", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  assert.ok(getReel(deps.db, gone.id)); // a cross-site POST deletes nothing

  const res = await act(gone.id, "delete", { "sec-fetch-site": "same-origin" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(getReel(deps.db, gone.id), null);
  assert.equal(existsSync(dir(gone)), false);
  assert.ok(existsSync(dir(keep)) && getReel(deps.db, keep.id)); // the other reel is untouched
  assert.equal((await fetch(`${base}/media/${gone.id}`)).status, 404);
  assert.deepEqual(linksIn(deps.db, "ignored").map((l) => l.bookmarkId), ["bm-1"]);
  assert.equal((await act(gone.id, "delete")).status, 303); // deleting again is harmless
});

test("Delete refuses a reel that is being processed, and a corrupted row cannot delete outside the media folder", async () => {
  const busy = addReel("busy1");
  await processReel(deps, busy.id);
  deps.db.prepare("UPDATE reels SET status = 'running' WHERE id = ?").run(busy.id);
  assert.equal((await act(busy.id, "delete")).status, 409);
  assert.ok(getReel(deps.db, busy.id));

  deps.db.prepare("INSERT INTO reels (id, platform, external_id, original_url, canonical_url, created_at, updated_at) VALUES ('bad1', 'fake', '../../outside', 'u', 'u', 't', 't')").run();
  assert.equal((await act("bad1", "delete")).status, 500);
  assert.ok(getReel(deps.db, "bad1")); // nothing was deleted
});
