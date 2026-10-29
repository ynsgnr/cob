import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FetchContext, FetchedMedia } from "../core/types.ts";

const run = promisify(execFile);
const GENERIC_TITLE = /^(video|reel|photo|post)\s+by\s+/i;

export function hashtags(text: string): string[] {
  const found = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!.toLowerCase());
  return [...new Set(found)].slice(0, 30);
}

// Pure: turns a yt-dlp info.json into our FetchedMedia (minus the file name).
export function parseInfo(info: Record<string, unknown>): Omit<FetchedMedia, "videoFile"> {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const caption = s(info.description);
  let title = s(info.title);
  if (!title || GENERIC_TITLE.test(title)) title = caption.split("\n")[0]!.slice(0, 120) || title || "Untitled";
  const extra = Array.isArray(info.tags) ? info.tags.filter((t): t is string => typeof t === "string") : [];
  const tags = [...new Set([...hashtags(caption), ...extra.map((t) => t.toLowerCase())])].slice(0, 30);
  const dur = typeof info.duration === "number" ? Math.round(info.duration) : null;
  return { title, caption, tags, author: s(info.uploader) || s(info.channel) || null, durationS: dur };
}

// Shared by every yt-dlp-backed provider: download `url` into `dir` as video.<ext> + video.info.json.
export async function ytdlpFetch(url: string, dir: string, ctx: FetchContext): Promise<FetchedMedia> {
  // An empty or missing file (e.g. a placeholder Secret) means "no cookies", not an error.
  const cookies = ctx.cookiesFile && (await stat(ctx.cookiesFile).catch(() => null))?.size ? ctx.cookiesFile : null;
  // yt-dlp rewrites the cookie jar on exit, so give it a throwaway copy.
  const tmp = cookies ? await mkdtemp(join(tmpdir(), "cob-")) : null;
  try {
    const args = [
      "--no-playlist", "--no-progress", "--write-info-json",
      "--max-filesize", "200M", "--match-filters", "duration<=?3600", // skipped videos exit 0 with no file, handled below
      "--js-runtimes", "node", // YouTube needs a JS runtime to solve its challenges
      "-S", "res:720,vcodec:h264,acodec:aac", "-f", "b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4",
      "--ffmpeg-location", ctx.ffmpegBin, "-o", join(dir, "video.%(ext)s"),
    ];
    if (tmp && cookies) {
      await copyFile(cookies, join(tmp, "cookies.txt"));
      args.push("--cookies", join(tmp, "cookies.txt"));
    }
    try {
      // env is scrubbed so the child never sees app secrets such as KARAKEEP_API_KEY
      await run(ctx.ytdlpBin, [...args, url], { timeout: 300_000, maxBuffer: 10_000_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? e);
      const last = stderr.trim().split("\n").pop() ?? "";
      const login = /login required|rate-limit|empty media response|locked behind the login/i.test(stderr);
      throw new Error(`yt-dlp failed${login ? " (the platform wants a logged-in session: set YTDLP_COOKIES_FILE)" : ""}: ${last}`.slice(0, 500));
    }
    const info = JSON.parse(await readFile(join(dir, "video.info.json"), "utf8").catch(() => {
      throw new Error("yt-dlp downloaded nothing (over 200 MB or 1 hour, or unavailable)");
    })) as Record<string, unknown>;
    const files = (await readdir(dir)).filter((f) => f.startsWith("video.") && !f.endsWith(".json"));
    const videoFile = files.find((f) => f === "video.mp4") ?? files[0]; // leftovers like video.f137.mp4 may exist
    if (!videoFile) throw new Error("yt-dlp produced no video file");
    return { ...parseInfo(info), videoFile };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
