import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { classify } from "../providers/index.ts";
import { rm } from "node:fs/promises";
import { ignoreLinksOf } from "../db/karakeep.ts";
import { countQueued, deleteReel, getReel, insertOrGet, listReels, retranscribe, retry } from "../db/reels.ts";
import { accessFor } from "../config.ts";
import { mediaPath, type Deps } from "../worker/pipeline.ts";
import { indexPage, layout, notFoundPage, reelPage } from "./views.ts";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska" };
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow", // archived copies of other people's videos should not be search-indexed
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; form-action 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}
const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), "application/json");
const redirect = (res: ServerResponse, to: string) => send(res, 303, "", "text/plain", { Location: to });

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 8192) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

const MAX_QUEUED = 100;
// All that a "public" host (see accessFor) may fetch: video pages, old /r links, media and the health check.
const PUBLIC_PATH = /^\/(?:healthz|(?:k|r|media)\/[A-Za-z0-9_-]+)$/;
const forbidden = (res: ServerResponse) => send(res, 403, layout("Forbidden", "<h1>Forbidden</h1>"));

// CSRF: browsers label every request with Sec-Fetch-Site, even when Referrer-Policy: no-referrer turns Origin into
// "null" on same-origin POSTs, and a proxy rewriting Host cannot break it. Without it (old browsers) fall back to
// Origin vs Host. Requests with neither header are not from a browser.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveMedia(deps: Deps, req: IncomingMessage, res: ServerResponse, id: string) {
  const reel = getReel(deps.db, id);
  if (!reel?.videoPath) return send(res, 404, notFoundPage());
  const file = mediaPath(deps.config, reel.videoPath);
  const size = (await stat(file).catch(() => null))?.size;
  if (size === undefined) return send(res, 404, notFoundPage());
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else start = Math.max(size - Number(m[2]), 0);
    if (start > end || start >= size) return send(res, 416, "", "text/plain", { "Content-Range": `bytes */${size}` });
    res.writeHead(206, { ...HEADERS, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  } else {
    res.writeHead(200, { ...HEADERS, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  }
  if (size === 0) return res.end();
  pipeline(createReadStream(file, { start, end }), res, () => {}); // destroys the file stream if the client leaves
}

async function handle(deps: Deps, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const post = req.method === "POST";

  const full = accessFor(deps.config, req.headers.host) === "full";
  if (!full && !(req.method === "GET" && PUBLIC_PATH.test(path))) return send(res, 404, notFoundPage());

  if (req.method === "GET" && path === "/healthz") return send(res, 200, "ok", "text/plain");
  if (req.method === "GET" && path === "/") {
    const q = (url.searchParams.get("q")?.trim() ?? "").slice(0, 100);
    const tag = (url.searchParams.get("tag")?.trim() ?? "").slice(0, 100);
    return send(res, 200, indexPage(listReels(deps.db, { q, tag }), q, tag));
  }

  // Submit: HTML form (redirects to the reel page) or JSON API (returns the reel URL).
  if (post && (path === "/submit" || path === "/api/reels")) {
    const api = path === "/api/reels";
    // JSON-only API: a cross-site form cannot send this content type without a CORS preflight.
    if (!sameOrigin(req) || (api && !req.headers["content-type"]?.startsWith("application/json"))) return forbidden(res);
    const fail = (status: number, error: string) => (api ? json(res, status, { error }) : send(res, status, indexPage(listReels(deps.db), "", "", error)));
    let raw = "";
    try {
      const body = await readBody(req);
      raw = api ? String((JSON.parse(body) as { url?: unknown }).url ?? "") : (new URLSearchParams(body).get("url") ?? "");
    } catch {
      return fail(400, "Invalid request");
    }
    const hit = raw.length <= 2048 ? classify(raw, deps.providers) : null;
    if (!hit) return fail(400, `Unsupported link. Supported: ${deps.providers.map((p) => p.id).join(", ")}.`);
    if (countQueued(deps.db) >= MAX_QUEUED) return fail(429, "Too many reels waiting, try again later.");
    const { reel, created } = insertOrGet(deps.db, { platform: hit.provider.id, externalId: hit.ref.externalId, originalUrl: raw.trim(), canonicalUrl: hit.ref.canonicalUrl });
    return api ? json(res, created ? 202 : 200, { id: reel.id, url: `/k/${reel.id}`, status: reel.status, created }) : redirect(res, `/k/${reel.id}`);
  }

  // Pages used to live under /r/<id>; bookmarks saved earlier keep working.
  const legacy = /^\/r\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "GET" && legacy) return send(res, 308, "", "text/plain", { Location: `/k/${legacy[1]}` });

  const m = /^\/(k|media|api\/reels)\/([A-Za-z0-9_-]+)(\/(?:retry|retranscribe|delete))?$/.exec(path);
  if (m) {
    const [, kind, id, tail] = m as unknown as [string, string, string, string | undefined];
    if (post && kind === "k" && tail) {
      if (!sameOrigin(req)) return forbidden(res);
      if (tail === "/delete") {
        const reel = getReel(deps.db, id);
        if (reel?.status === "running") return send(res, 409, layout("Busy", `<h1>Still processing</h1><p>Try again when it has finished.</p><p><a href="/k/${id}">Back</a></p>`));
        if (reel) {
          // Only this reel's own folder. Resolved first, so a bad row throws before anything is deleted.
          const dir = mediaPath(deps.config, `${reel.platform}/${reel.externalId}`);
          deleteReel(deps.db, id);
          ignoreLinksOf(deps.db, id);
          await rm(dir, { recursive: true, force: true });
        }
        return redirect(res, "/");
      }
      if (tail === "/retranscribe") retranscribe(deps.db, id);
      else retry(deps.db, id);
      return redirect(res, `/k/${id}`);
    }
    if (req.method === "GET" && !tail) {
      if (kind === "media") return serveMedia(deps, req, res, id);
      const reel = getReel(deps.db, id);
      if (!reel) return send(res, 404, notFoundPage());
      return kind === "k" ? send(res, 200, reelPage(reel, full)) : json(res, 200, reel);
    }
  }
  send(res, 404, notFoundPage());
}

export function createApp(deps: Deps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((e) => {
      console.error("request failed", e);
      if (!res.headersSent) send(res, 500, layout("Error", "<h1>Something went wrong</h1>"));
      else res.destroy();
    });
  });
}
