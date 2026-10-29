import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { getReel } from "../src/db/reels.ts";

test("opening a database from before the transcript_source column migrates it and keeps the rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cob-mig-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE reels (id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, original_url TEXT NOT NULL, canonical_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', error TEXT, title TEXT, caption TEXT, tags TEXT NOT NULL DEFAULT '[]', author TEXT, duration_s INTEGER, video_path TEXT,
    transcript TEXT, transcript_status TEXT NOT NULL DEFAULT 'pending', transcript_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (platform, external_id))`);
  old.prepare("INSERT INTO reels (id, platform, external_id, original_url, canonical_url, title, transcript, transcript_status, created_at, updated_at) VALUES ('a1', 'fake', 'x', 'u', 'u', 'Old title', 'old text', 'done', 't', 't')").run();
  old.close();

  const db = openDb(path);
  assert.deepEqual({ title: getReel(db, "a1")!.title, transcript: getReel(db, "a1")!.transcript, source: getReel(db, "a1")!.transcriptSource }, { title: "Old title", transcript: "old text", source: null });
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  db.close();
  openDb(path).close(); // a second open must not try to add the column again
});

test("SUBTITLES is off, manual or auto (default auto)", () => {
  assert.equal(loadConfig({}).subtitles, "auto");
  assert.equal(loadConfig({ SUBTITLES: "manual" }).subtitles, "manual");
  assert.equal(loadConfig({ SUBTITLES: "off" }).subtitles, "off");
  assert.throws(() => loadConfig({ SUBTITLES: "yes" }), /SUBTITLES/);
});
