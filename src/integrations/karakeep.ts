import { addLink, getMeta, isKnown, linksIn, setLinkState, setMeta } from "../db/karakeep.ts";
import { getReel, insertOrGet } from "../db/reels.ts";
import { classify } from "../providers/index.ts";
import type { Deps } from "../worker/pipeline.ts";

// Ducttape integration: for each new Karakeep link a provider understands, Cob archives it and adds its own
// /k/<id> link to Karakeep. With replace on it then deletes the original (tags, lists and flags of it are lost).

export interface KkBookmark { id: string; createdAt: string; url: string | null; note: string | null }
export interface KarakeepClient {
  list(cursor?: string): Promise<{ bookmarks: KkBookmark[]; nextCursor: string | null }>;
  create(url: string, title: string | null, note: string | null): Promise<string>;
  remove(id: string): Promise<void>;
}

export function karakeepClient(baseUrl: string, apiKey: string): KarakeepClient {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`karakeep ${method} ${path} -> ${res.status}`);
    return res.status === 204 || method === "DELETE" ? null : ((await res.json()) as Record<string, unknown>);
  };
  return {
    async list(cursor) {
      const r = (await call("GET", `/bookmarks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { bookmarks: { id: string; createdAt: string; note?: string | null; content?: { type?: string; url?: string } }[]; nextCursor?: string | null };
      return { bookmarks: r.bookmarks.map((b) => ({ id: b.id, createdAt: b.createdAt, url: b.content?.type === "link" ? (b.content.url ?? null) : null, note: b.note ?? null })), nextCursor: r.nextCursor ?? null };
    },
    async create(url, title, note) {
      const r = await call("POST", "/bookmarks", { type: "link", url, ...(title ? { title: title.slice(0, 1000) } : {}), ...(note ? { note } : {}) });
      if (typeof r?.id !== "string") throw new Error("karakeep create returned no id");
      return r.id;
    },
    async remove(id) { await call("DELETE", `/bookmarks/${encodeURIComponent(id)}`); },
  };
}

export interface SyncOptions { publicBaseUrl: string; backfill: boolean; replace: boolean }

const MARGIN_MS = 5 * 60_000; // covers clock skew between Karakeep and Cob
const MAX_PAGES = 20;

export async function syncOnce(deps: Deps, kk: KarakeepClient, opts: SyncOptions): Promise<void> {
  const { db } = deps;
  // Only links added after the integration was first switched on, unless KARAKEEP_BACKFILL=true.
  const since = Number(getMeta(db, "karakeep_since") ?? (opts.backfill ? 0 : Date.now()));

  // 1. Scan newest first down to `since`. `since` only advances after a complete scan, so a failed page is retried.
  let newest = 0;
  let complete = false;
  for (let cursor: string | undefined, page = 0; page < MAX_PAGES && !complete; page++) {
    const { bookmarks, nextCursor } = await kk.list(cursor);
    for (const b of bookmarks) {
      const created = Date.parse(b.createdAt);
      newest = Math.max(newest, created);
      if (created < since) { complete = true; break; }
      if (isKnown(db, b.id)) continue;
      const hit = b.url && !b.url.startsWith(opts.publicBaseUrl + "/") ? classify(b.url, deps.providers) : null;
      if (!b.url || !hit) { addLink(db, b.id, "ignored"); continue; }
      const { reel } = insertOrGet(db, { platform: hit.provider.id, externalId: hit.ref.externalId, originalUrl: b.url, canonicalUrl: hit.ref.canonicalUrl });
      addLink(db, b.id, "waiting", reel.id, b.note);
    }
    if (!nextCursor) complete = true;
    cursor = nextCursor ?? undefined;
  }
  if (complete) setMeta(db, "karakeep_since", String(Math.max(since, newest - MARGIN_MS)));

  // 2. Swap links whose reel is archived. A failed transcript keeps the original until the reel is retried.
  //    Karakeep returns the existing bookmark for a URL it already has, so a repeated create is harmless.
  for (const link of linksIn(db, "waiting")) {
    const reel = link.reelId ? getReel(db, link.reelId) : null;
    if (!reel || reel.status !== "done" || reel.transcriptStatus === "failed") continue;
    await step(link.bookmarkId, async () => {
      const newId = await kk.create(`${opts.publicBaseUrl}/k/${reel.id}`, reel.title, link.note);
      setLinkState(db, link.bookmarkId, opts.replace ? "created" : "done", newId);
    });
  }
  // 3. Delete the originals (only with KARAKEEP_REPLACE). Separate state so a failed delete retries without a second create.
  for (const link of opts.replace ? linksIn(db, "created") : []) {
    await step(link.bookmarkId, async () => {
      await kk.remove(link.bookmarkId);
      setLinkState(db, link.bookmarkId, "done");
      console.log(`karakeep: replaced ${link.bookmarkId} with ${link.newBookmarkId}`);
    });
  }
}

// One bad link must not block the others.
async function step(bookmarkId: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { console.error(`karakeep: ${bookmarkId}:`, e instanceof Error ? e.message : e); }
}

export function startKarakeepSync(deps: Deps, kk: KarakeepClient, opts: SyncOptions, pollMs: number): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await syncOnce(deps, kk, opts); } catch (e) { console.error("karakeep sync failed:", e instanceof Error ? e.message : e); } finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), pollMs);
  return () => clearInterval(timer);
}
