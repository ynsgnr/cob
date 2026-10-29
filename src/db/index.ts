import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  original_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  title TEXT,
  caption TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  author TEXT,
  duration_s INTEGER,
  video_path TEXT,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  transcript_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS reels_created ON reels (created_at DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- One row per Karakeep bookmark we have looked at. state: ignored | waiting | created | done
CREATE TABLE IF NOT EXISTS karakeep_links (
  bookmark_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reel_id TEXT,
  new_bookmark_id TEXT,
  note TEXT
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
