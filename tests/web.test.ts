import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { insertOrGet } from "../src/db/reels.ts";
import { processReel } from "../src/worker/pipeline.ts";
import { createApp } from "../src/web/server.ts";
import { makeDeps } from "./helpers.ts";

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
