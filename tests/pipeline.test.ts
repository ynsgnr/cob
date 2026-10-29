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

test("transcription failure or no server never fails the reel, and a retry only redoes the transcript", async () => {
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
  assert.equal(fakeProvider.calls, before + 2); // asked again (yt-dlp skips the video it already has, so this is cheap)

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

test("captions from the platform replace transcribing, and say where they came from", async () => {
  let transcribed = 0;
  const deps = makeDeps({ transcribe: async () => { transcribed++; return "whisper text"; } });
  fakeProvider.subs = { text: "caption text from the platform", auto: false };
  try {
    const { reel } = add(deps, "caps1");
    await processReel(deps, reel.id);
    const r = getReel(deps.db, reel.id)!;
    assert.equal(r.status, "done");
    assert.equal(r.transcript, "caption text from the platform");
    assert.equal(r.transcriptSource, "subtitles");
    assert.equal(transcribed, 0);

    fakeProvider.subs = { text: "auto generated text", auto: true };
    const auto = add(deps, "caps2").reel;
    await processReel(deps, auto.id);
    assert.equal(getReel(deps.db, auto.id)!.transcriptSource, "auto-captions");
  } finally { fakeProvider.subs = undefined; }
});

test("without captions Whisper is used and labelled; a retry after a failed transcript re-checks for captions, a finished one does not", async () => {
  const deps = makeDeps({ transcribe: async () => { throw new Error("down"); } });
  const { reel } = add(deps, "caps3");
  await processReel(deps, reel.id);
  assert.equal(getReel(deps.db, reel.id)!.transcriptStatus, "failed");

  const before = fakeProvider.calls;
  fakeProvider.subs = { text: "captions appeared later", auto: true };
  try {
    retry(deps.db, reel.id);
    await processReel(deps, reel.id);
    assert.equal(fakeProvider.calls, before + 1); // fetched again, the platform may have captions now
    assert.equal(getReel(deps.db, reel.id)!.transcript, "captions appeared later");

    retry(deps.db, reel.id);
    await processReel(deps, reel.id);
    assert.equal(fakeProvider.calls, before + 1); // transcript is done: nothing is fetched again
  } finally { fakeProvider.subs = undefined; }

  const ok = makeDeps();
  const w = add(ok, "caps4").reel;
  await processReel(ok, w.id);
  assert.equal(getReel(ok.db, w.id)!.transcriptSource, "whisper");
});
