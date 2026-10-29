import type { Provider } from "../core/types.ts";
import { ytdlpFetch } from "./ytdlp.ts";

const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
// /reel/CODE, /reels/CODE, /p/CODE, /tv/CODE, each optionally behind /<user>/
const PATH = /^\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)\/?$/;

export const instagram: Provider = {
  id: "instagram",
  match(url) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!HOSTS.has(url.hostname)) return null;
    const code = PATH.exec(url.pathname)?.[1];
    if (!code) return null;
    return { externalId: code, canonicalUrl: `https://www.instagram.com/reel/${code}/` };
  },
  fetch: ytdlpFetch,
};
