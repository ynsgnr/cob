// Spec of record for the platform seam: the pipeline, DB and UI only ever see these types.

export type ReelStatus = "queued" | "running" | "done" | "failed";
export type TranscriptStatus = "pending" | "done" | "skipped" | "failed";
export type TranscriptSource = "subtitles" | "auto-captions" | "whisper";
export type SubtitleMode = "off" | "manual" | "auto";

export interface Reel {
  id: string;
  platform: string;
  externalId: string;
  originalUrl: string;
  canonicalUrl: string;
  status: ReelStatus;
  error: string | null;
  title: string | null;
  caption: string | null;
  tags: string[];
  author: string | null;
  durationS: number | null;
  videoPath: string | null; // relative to MEDIA_DIR
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptError: string | null;
  transcriptSource: TranscriptSource | null;
}

export interface FetchedMedia {
  title: string;
  caption: string;
  tags: string[];
  author: string | null;
  durationS: number | null;
  videoFile: string; // file name inside the directory handed to fetch()
  subtitles?: { text: string; auto: boolean }; // the platform's own captions, when it has them: saves transcribing
}

export interface FetchContext {
  ytdlpBin: string;
  ffmpegBin: string;
  cookiesFile: string | null;
  subtitles: SubtitleMode;
  subtitleLang: string;
}

export interface ProviderRef {
  externalId: string; // [A-Za-z0-9_-]+, used in file paths
  canonicalUrl: string; // rebuilt from the id, the only URL ever handed to fetch()
}

export interface Provider {
  id: string;
  match(url: URL): ProviderRef | null;
  fetch(canonicalUrl: string, dir: string, ctx: FetchContext): Promise<FetchedMedia>;
}
