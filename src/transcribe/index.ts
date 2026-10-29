import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { transcribePcm } from "./wyoming.ts";

const run = promisify(execFile);

export type Transcriber = (videoPath: string) => Promise<string>;

export async function extractPcm(ffmpegBin: string, videoPath: string): Promise<Buffer> {
  const args = ["-v", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"];
  const { stdout } = await run(ffmpegBin, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 300_000, env: { PATH: process.env.PATH } });
  return stdout;
}

// The shared GPU behind the Wyoming server sometimes runs out of memory and drops the connection; a retry usually passes.
export async function withRetries<T>(fn: () => Promise<T>, tries = 3, delayMs = 4000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

// Long audio makes the Wyoming server run out of GPU memory (a 54 s reel failed, 30 s passed), so send short pieces.
const PIECE_BYTES = 25 * 32000; // 25 s of 16 kHz mono s16le
export function splitPcm(pcm: Buffer, size = PIECE_BYTES): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, i + size));
  return out;
}

// null when WYOMING_URL is unset: the pipeline then records the transcript as skipped.
export function makeTranscriber(config: Config): Transcriber | null {
  const url = config.wyomingUrl;
  if (!url) return null;
  return async (videoPath) => {
    const pcm = await extractPcm(config.ffmpegBin, videoPath);
    const parts: string[] = [];
    for (const piece of splitPcm(pcm)) parts.push(await withRetries(() => transcribePcm(url, piece, { language: config.whisperLanguage })));
    return parts.filter(Boolean).join(" ");
  };
}
