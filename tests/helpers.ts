import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Provider } from "../src/core/types.ts";
import { openDb } from "../src/db/index.ts";
import type { Deps } from "../src/worker/pipeline.ts";

// Matches example.test/v/<id> and "downloads" a tiny file; no network, no yt-dlp.
export const fakeProvider: Provider & { calls: number; subs?: { text: string; auto: boolean } } = {
  id: "fake",
  calls: 0,
  match(url) {
    const id = /^\/v\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    return url.hostname === "example.test" && id ? { externalId: id, canonicalUrl: `https://example.test/v/${id}` } : null;
  },
  async fetch(_url, dir) {
    this.calls++;
    await writeFile(join(dir, "video.mp4"), "0123456789");
    return { title: "Fake title", caption: "cap #one #Two", tags: ["one", "two"], author: "someone", durationS: 12, videoFile: "video.mp4", subtitles: this.subs };
  },
};

export function makeDeps(over: Partial<Deps> = {}): Deps {
  const mediaDir = mkdtempSync(join(tmpdir(), "cob-test-"));
  const config = { ...loadConfig({}), mediaDir, jobGapMs: 0 };
  return { db: openDb(":memory:"), config, providers: [fakeProvider], transcribe: async () => "hello world", ...over };
}
