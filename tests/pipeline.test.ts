import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { claimNext, getReel, insertOrGet, listReels, requeueRunning, retry } from "../src/db/reels.ts";
import { mediaPath, processReel } from "../src/worker/pipeline.ts";
import { fakeProvider, makeDeps } from "./helpers.ts";

const add = (deps: ReturnType<typeof makeDeps>, id = "abc") =>
  insertOrGet(deps.db, { platform: "fake", externalId: id, originalUrl: `https://example.test/v/${id}?utm=1`, canonicalUrl: `https://example.test/v/${id}` });

test("dedup: same platform+id returns the existing reel", () => {
  const deps = makeDeps();
  const a = add(deps);
  const b = add(deps);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.reel.id, b.reel.id);
  assert.equal(a.reel.originalUrl, "https://example.test/v/abc?utm=1"); // original link kept
});

test("pipeline downloads, stores metadata and transcript", async () => {
  const deps = makeDeps();
  const { reel } = add(deps);
  await processReel(deps, reel.id);
  const r = getReel(deps.db, reel.id)!;
  assert.equal(r.status, "done");
  assert.equal(r.title, "Fake title");
  assert.deepEqual(r.tags, ["one", "two"]);
  assert.equal(r.transcript, "hello world");
  assert.equal(r.videoPath, "fake/abc/video.mp4");
  assert.ok(existsSync(mediaPath(deps.config, r.videoPath!)));
});

test("transcription failure or no server never fails the reel, and retry resumes without re-downloading", async () => {
  const before = fakeProvider.calls;
  const deps = makeDeps({ transcribe: async () => { throw new Error("whisper down"); } });
  const { reel } = add(deps);
  await processReel(deps, reel.id);
  let r = getReel(deps.db, reel.id)!;
  assert.equal(r.status, "done");
  assert.equal(r.transcriptStatus, "failed");
  assert.equal(r.transcriptError, "transcription service error"); // detail is logged, not stored

  deps.transcribe = async () => "now works";
  assert.ok(retry(deps.db, reel.id));
  await processReel(deps, reel.id);
  r = getReel(deps.db, reel.id)!;
  assert.equal(r.transcript, "now works");
  assert.equal(fakeProvider.calls, before + 1);

  const none = makeDeps({ transcribe: null });
  await processReel(none, add(none).reel.id);
  assert.equal(listReels(none.db)[0]!.transcriptStatus, "skipped");
});

test("a provider failure marks the reel failed with the message", async () => {
  const deps = makeDeps({ providers: [{ ...fakeProvider, fetch: async () => { throw new Error("login wall"); } }] });
  const { reel } = add(deps);
  await processReel(deps, reel.id);
  const r = getReel(deps.db, reel.id)!;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "login wall");
});

test("queue: claim is oldest first, running rows requeue after a crash", () => {
  const deps = makeDeps();
  const a = add(deps, "a").reel;
  add(deps, "b");
  assert.equal(claimNext(deps.db), a.id);
  requeueRunning(deps.db);
  assert.equal(getReel(deps.db, a.id)!.status, "queued");
});

test("search matches transcript, tag filter is exact, LIKE wildcards are literal", async () => {
  const deps = makeDeps();
  await processReel(deps, add(deps).reel.id);
  assert.equal(listReels(deps.db, { q: "hello" }).length, 1);
  assert.equal(listReels(deps.db, { q: "nothing" }).length, 0);
  assert.equal(listReels(deps.db, { q: "%" }).length, 0);
  assert.equal(listReels(deps.db, { tag: "one" }).length, 1);
  assert.equal(listReels(deps.db, { tag: "on" }).length, 0);
});

test("mediaPath refuses to leave MEDIA_DIR", () => {
  const deps = makeDeps();
  assert.throws(() => mediaPath(deps.config, "../etc/passwd"));
  assert.throws(() => mediaPath(deps.config, "/etc/passwd"));
});
