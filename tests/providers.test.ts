import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, providers } from "../src/providers/index.ts";
import { hashtags, parseInfo, parseJson3, pickTrack } from "../src/providers/ytdlp.ts";

test("instagram urls normalise to one id", () => {
  for (const u of [
    "https://www.instagram.com/reel/ABC_123-x/",
    "https://instagram.com/reel/ABC_123-x/?igsh=zzz",
    "http://m.instagram.com/someuser/reel/ABC_123-x",
    "https://www.instagram.com/reels/ABC_123-x/",
    "https://www.instagram.com/p/ABC_123-x/",
  ]) {
    const hit = classify(u, providers);
    assert.equal(hit?.provider.id, "instagram", u);
    assert.equal(hit?.ref.externalId, "ABC_123-x");
    assert.equal(hit?.ref.canonicalUrl, "https://www.instagram.com/reel/ABC_123-x/");
  }
});

test("other hosts, schemes and shapes are rejected", () => {
  for (const u of [
    "https://evil.example/reel/ABC/",
    "https://www.instagram.com.evil.example/reel/ABC/",
    "https://www.instagram.com/reels/audio/123/",
    "https://www.instagram.com/someuser/",
    "ftp://www.instagram.com/reel/ABC/",
    "file:///etc/passwd",
    "not a url",
    "",
  ]) assert.equal(classify(u, providers), null, u);
});

test("hashtags are lowercased, unique, unicode aware", () => {
  assert.deepEqual(hashtags("hi #Cook #cook #café_1 no# tag"), ["cook", "café_1"]);
});

test("parseInfo replaces generic titles with the caption's first line", () => {
  const r = parseInfo({ title: "Video by chef", description: "Best pasta\n#pasta #Easy", uploader: "chef", duration: 12.4 });
  assert.equal(r.title, "Best pasta");
  assert.deepEqual(r.tags, ["pasta", "easy"]);
  assert.equal(r.author, "chef");
  assert.equal(r.durationS, 12);
  assert.equal(parseInfo({ title: "Real title", description: "x" }).title, "Real title");
  assert.equal(parseInfo({}).title, "Untitled");
});

test("youtube videos and shorts normalise to one watch link, dropping playlist and tracking params", () => {
  for (const u of [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc&t=10s",
    "https://youtube.com/watch?feature=share&v=jNQXAC9IVRw",
    "https://m.youtube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw?si=tracking",
    "https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share",
    "https://m.youtube.com/shorts/jNQXAC9IVRw/",
    "https://www.youtube.com/live/jNQXAC9IVRw",
    "https://www.youtube.com/embed/jNQXAC9IVRw",
  ]) {
    const hit = classify(u, providers);
    assert.equal(hit?.provider.id, "youtube", u);
    assert.equal(hit?.ref.externalId, "jNQXAC9IVRw", u);
    assert.equal(hit?.ref.canonicalUrl, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  }
});

test("youtube: playlists, channels, bad ids and look-alike hosts are rejected", () => {
  for (const u of [
    "https://www.youtube.com/playlist?list=PLabc",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=jNQXAC9IVRwTOOLONG",
    "https://www.youtube.com/watch?v=jNQXAC9IVR%3B",
    "https://www.youtube.com/shorts/jNQXAC9IVRw/extra",
    "https://youtu.be/jNQXAC9IVRw/extra",
    "https://www.youtube.com.evil.io/watch?v=jNQXAC9IVRw",
    "https://evil.io/youtu.be/jNQXAC9IVRw",
    "https://music.youtube.com/watch?v=jNQXAC9IVRw",
  ]) assert.equal(classify(u, providers), null, u);
});

test("a youtube id that looks like a flag stays inside the https url handed to yt-dlp", () => {
  const hit = classify("https://youtu.be/--help-----", providers);
  assert.equal(hit?.ref.canonicalUrl, "https://www.youtube.com/watch?v=--help-----");
});

test("parseJson3 joins caption events, drops [tags] and repeated lines, ignores timing-only events", () => {
  const raw = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000 },
    { segs: [{ utf8: "[Music]" }] },
    { segs: [{ utf8: "hello " }, { utf8: "there" }] },
    { segs: [{ utf8: "hello there" }] },
    { segs: [{ utf8: "\n" }] },
    { segs: [{ utf8: "second   line\nwraps" }, { utf8: " [Applause]" }] },
  ] });
  assert.equal(parseJson3(raw), "hello there second line wraps");
  assert.equal(parseJson3("{}"), "");
});

test("pickTrack: human subtitles first, then the original auto track, never translations, nothing when off", () => {
  const manual = { subtitles: { en: [{}], fr: [{}] }, automatic_captions: { en: [{}], "en-orig": [{}] } };
  const autoOnly = { subtitles: {}, automatic_captions: { en: [{}], "en-orig": [{}], de: [{}] } };
  const translationsOnly = { subtitles: {}, automatic_captions: { en: [{}], de: [{}] } }; // e.g. a French video offered in English
  assert.deepEqual(pickTrack(manual, "auto", "en"), { lang: "en", auto: false });
  assert.deepEqual(pickTrack(manual, "manual", "en"), { lang: "en", auto: false });
  assert.deepEqual(pickTrack(autoOnly, "auto", "en"), { lang: "en-orig", auto: true });
  assert.equal(pickTrack(autoOnly, "manual", "en"), null); // manual mode never takes auto captions
  assert.equal(pickTrack(translationsOnly, "auto", "en"), null);
  assert.equal(pickTrack(manual, "off", "en"), null);
  assert.equal(pickTrack({}, "auto", "en"), null); // e.g. Instagram: no caption request at all
  assert.deepEqual(pickTrack({ subtitles: {}, automatic_captions: { "de-orig": [{}] } }, "auto", "de"), { lang: "de-orig", auto: true });
});
