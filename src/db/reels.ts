import { randomBytes } from "node:crypto";
import type { FetchedMedia, Reel } from "../core/types.ts";
import type { Db } from "./index.ts";

type Row = Record<string, string | number | null>;

function toReel(r: Row): Reel {
  return {
    id: r.id as string,
    platform: r.platform as string,
    externalId: r.external_id as string,
    originalUrl: r.original_url as string,
    canonicalUrl: r.canonical_url as string,
    status: r.status as Reel["status"],
    error: r.error as string | null,
    title: r.title as string | null,
    caption: r.caption as string | null,
    tags: JSON.parse(r.tags as string) as string[],
    author: r.author as string | null,
    durationS: r.duration_s as number | null,
    videoPath: r.video_path as string | null,
    transcript: r.transcript as string | null,
    transcriptStatus: r.transcript_status as Reel["transcriptStatus"],
    transcriptError: r.transcript_error as string | null,
    transcriptSource: r.transcript_source as Reel["transcriptSource"],
  };
}

const now = () => new Date().toISOString();
const one = (db: Db, sql: string, ...p: (string | number)[]) => {
  const row = db.prepare(sql).get(...p) as Row | undefined;
  return row ? toReel(row) : null;
};

export function getReel(db: Db, id: string): Reel | null {
  return one(db, "SELECT * FROM reels WHERE id = ?", id);
}

// Dedup: the same (platform, external_id) always returns the existing reel.
export function insertOrGet(db: Db, v: { platform: string; externalId: string; originalUrl: string; canonicalUrl: string }): { reel: Reel; created: boolean } {
  const existing = one(db, "SELECT * FROM reels WHERE platform = ? AND external_id = ?", v.platform, v.externalId);
  if (existing) return { reel: existing, created: false };
  const id = randomBytes(6).toString("base64url");
  const t = now();
  db.prepare("INSERT INTO reels (id, platform, external_id, original_url, canonical_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, v.platform, v.externalId, v.originalUrl, v.canonicalUrl, t, t);
  return { reel: getReel(db, id)!, created: true };
}

// q matches title, caption, transcript, tags and author (plain LIKE for now).
export function listReels(db: Db, opts: { q?: string; tag?: string } = {}): Reel[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  if (opts.tag) {
    where.push("tags LIKE ? ESCAPE '\\'");
    params.push(`%"${opts.tag.replace(/[\\%_"]/g, "\\$&")}"%`);
  }
  const sql = `SELECT * FROM reels ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`;
  return (db.prepare(sql).all(...params) as Row[]).map(toReel);
}

export function countQueued(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM reels WHERE status = 'queued'").get() as { n: number }).n;
}

// Single process, so select-then-update cannot race with another claimer.
export function claimNext(db: Db): string | null {
  const row = db.prepare("SELECT id FROM reels WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE reels SET status = 'running', error = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
  return row.id;
}

export function requeueRunning(db: Db): void {
  db.prepare("UPDATE reels SET status = 'queued' WHERE status = 'running'").run();
}

export function retry(db: Db, id: string): boolean {
  const r = db.prepare("UPDATE reels SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status IN ('done', 'failed')").run(now(), id);
  return Number(r.changes) > 0;
}

export function saveFetched(db: Db, id: string, m: FetchedMedia, videoPath: string): void {
  db.prepare("UPDATE reels SET title = ?, caption = ?, tags = ?, author = ?, duration_s = ?, video_path = ?, updated_at = ? WHERE id = ?").run(m.title, m.caption, JSON.stringify(m.tags), m.author, m.durationS, videoPath, now(), id);
}

export function saveTranscript(db: Db, id: string, status: Reel["transcriptStatus"], text: string | null, error: string | null, source: Reel["transcriptSource"] = null): void {
  db.prepare("UPDATE reels SET transcript_status = ?, transcript = ?, transcript_error = ?, transcript_source = ?, updated_at = ? WHERE id = ?").run(status, text, error, source, now(), id);
}

export function finish(db: Db, id: string, status: "done" | "failed", error: string | null): void {
  db.prepare("UPDATE reels SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
}
