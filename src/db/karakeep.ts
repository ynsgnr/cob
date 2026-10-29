import type { Db } from "./index.ts";

export type LinkState = "ignored" | "waiting" | "created" | "done";
export interface KarakeepLink { bookmarkId: string; state: LinkState; reelId: string | null; newBookmarkId: string | null; note: string | null }

const toLink = (r: Record<string, unknown>): KarakeepLink => ({ bookmarkId: r.bookmark_id as string, state: r.state as LinkState, reelId: r.reel_id as string | null, newBookmarkId: r.new_bookmark_id as string | null, note: r.note as string | null });

export const isKnown = (db: Db, bookmarkId: string): boolean => !!db.prepare("SELECT 1 FROM karakeep_links WHERE bookmark_id = ?").get(bookmarkId);

export function addLink(db: Db, bookmarkId: string, state: LinkState, reelId: string | null = null, note: string | null = null): void {
  db.prepare("INSERT OR IGNORE INTO karakeep_links (bookmark_id, state, reel_id, note) VALUES (?, ?, ?, ?)").run(bookmarkId, state, reelId, note);
}

export const linksIn = (db: Db, state: LinkState): KarakeepLink[] =>
  (db.prepare("SELECT * FROM karakeep_links WHERE state = ?").all(state) as Record<string, unknown>[]).map(toLink);

export function setLinkState(db: Db, bookmarkId: string, state: LinkState, newBookmarkId?: string): void {
  db.prepare("UPDATE karakeep_links SET state = ?, new_bookmark_id = COALESCE(?, new_bookmark_id) WHERE bookmark_id = ?").run(state, newBookmarkId ?? null, bookmarkId);
}

export const getMeta = (db: Db, key: string): string | null => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
export const setMeta = (db: Db, key: string, value: string): void => { db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value); };
