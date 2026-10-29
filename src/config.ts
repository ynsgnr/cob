export interface Config {
  port: number;
  mediaDir: string;
  databasePath: string;
  wyomingUrl: string | null;
  whisperLanguage: string | null;
  ytdlpBin: string;
  ffmpegBin: string;
  cookiesFile: string | null;
  jobGapMs: number;
  publicHost: string | null;
  internalHost: string | null;
  karakeep: { url: string; apiKey: string; publicBaseUrl: string; pollMs: number; backfill: boolean; replace: boolean } | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const str = (k: string) => env[k]?.trim() || null;
  const num = (k: string, d: number) => {
    const v = str(k);
    if (v === null) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a non-negative integer`);
    return n;
  };
  const hostname = (k: string) => {
    const h = str(k)?.toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "") ?? null;
    if (h !== null && !/^[a-z0-9.-]+$/.test(h)) throw new Error(`${k} must be a hostname`);
    return h;
  };
  // The integration is on when KARAKEEP_API_KEY is set; it then needs the other two.
  const apiKey = str("KARAKEEP_API_KEY");
  let karakeep: Config["karakeep"] = null;
  if (apiKey) {
    const url = str("KARAKEEP_URL");
    const publicBaseUrl = str("PUBLIC_BASE_URL");
    if (!url || !publicBaseUrl) throw new Error("KARAKEEP_API_KEY needs KARAKEEP_URL and PUBLIC_BASE_URL");
    karakeep = { url: url.replace(/\/+$/, ""), apiKey, publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""), pollMs: num("KARAKEEP_POLL_MS", 60_000), backfill: str("KARAKEEP_BACKFILL") === "true", replace: str("KARAKEEP_REPLACE") === "true" };
  }
  return {
    port: num("PORT", 3000),
    mediaDir: str("MEDIA_DIR") ?? "./data/media",
    databasePath: str("DATABASE_PATH") ?? "./data/cob.db",
    wyomingUrl: str("WYOMING_URL"),
    whisperLanguage: str("WHISPER_LANGUAGE"),
    ytdlpBin: str("YTDLP_BIN") ?? "yt-dlp",
    ffmpegBin: str("FFMPEG_BIN") ?? "ffmpeg",
    cookiesFile: str("YTDLP_COOKIES_FILE"),
    jobGapMs: num("JOB_GAP_MS", 5000),
    publicHost: hostname("PUBLIC_HOST"),
    internalHost: hostname("INTERNAL_HOST"),
    karakeep,
  };
}

// "public" hosts may only read the per-video pages and media; "full" hosts may do everything.
// INTERNAL_HOST set: only that host is full (everything else is treated as public, so unknown hosts fail closed).
// Only PUBLIC_HOST set: that host is public, others are full. Neither: everything is full.
export function accessFor(c: Pick<Config, "publicHost" | "internalHost">, hostHeader: string | undefined): "full" | "public" {
  const host = (hostHeader ?? "").toLowerCase().replace(/:\d+$/, "");
  if (c.internalHost) return host === c.internalHost ? "full" : "public";
  return c.publicHost && host === c.publicHost ? "public" : "full";
}
