import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import type { Provider } from "../core/types.ts";
import type { Db } from "../db/index.ts";
import { finish, getReel, saveFetched, saveTranscript } from "../db/reels.ts";
import type { Transcriber } from "../transcribe/index.ts";

export interface Deps {
  db: Db;
  config: Config;
  providers: Provider[];
  transcribe: Transcriber | null;
}

// Resolve a MEDIA_DIR-relative path, refusing anything that escapes it.
export function mediaPath(config: Config, rel: string): string {
  const root = resolve(config.mediaDir);
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) throw new Error("path escapes MEDIA_DIR");
  return full;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// Each step is skipped when its result already exists, so a retry resumes where it stopped.
export async function processReel(deps: Deps, id: string): Promise<void> {
  const { db, config } = deps;
  try {
    const reel = getReel(db, id);
    if (!reel) return;
    const provider = deps.providers.find((p) => p.id === reel.platform);
    if (!provider) throw new Error(`no provider for ${reel.platform}`);

    // Fetch when the video is missing, and again on a retry that still needs a transcript: yt-dlp skips a video it
    // already has, so this is cheap, and it gives the platform's captions another chance.
    let rel = reel.videoPath;
    let captioned = false;
    if (!rel || !existsSync(mediaPath(config, rel)) || reel.transcriptStatus !== "done") {
      const dirRel = `${reel.platform}/${reel.externalId}`;
      const dir = mediaPath(config, dirRel);
      await mkdir(dir, { recursive: true });
      const media = await provider.fetch(reel.canonicalUrl, dir, { ytdlpBin: config.ytdlpBin, ffmpegBin: config.ffmpegBin, cookiesFile: config.cookiesFile, subtitles: config.subtitles, subtitleLang: config.whisperLanguage ?? "en" });
      rel = `${dirRel}/${media.videoFile}`;
      saveFetched(db, id, media, rel);
      if (media.subtitles && reel.transcriptStatus !== "done") {
        saveTranscript(db, id, "done", media.subtitles.text, null, media.subtitles.auto ? "auto-captions" : "subtitles");
        captioned = true;
      }
    }

    if (reel.transcriptStatus !== "done" && !captioned) {
      if (!deps.transcribe) saveTranscript(db, id, "skipped", null, "WYOMING_URL is not set");
      else {
        try {
          saveTranscript(db, id, "done", await deps.transcribe(mediaPath(config, rel)), null, "whisper");
        } catch (e) {
          console.error(`transcription failed for ${id}:`, msg(e)); // detail stays in the log: it can name internal hosts
          saveTranscript(db, id, "failed", null, "transcription service error"); // the reel stays usable without a transcript
        }
      }
    }
    finish(db, id, "done", null);
  } catch (e) {
    finish(db, id, "failed", msg(e));
  }
}
