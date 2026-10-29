import type { Provider } from "../core/types.ts";
import { ytdlpFetch } from "./ytdlp.ts";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const ID = /^[A-Za-z0-9_-]{11}$/;
const PATH = /^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/;

// Videos and Shorts share one id space, so both dedup to the same watch link. Playlists and channels are not matched.
export const youtube: Provider = {
  id: "youtube",
  match(url) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!HOSTS.has(url.hostname)) return null;
    const id =
      url.hostname === "youtu.be" ? url.pathname.slice(1).replace(/\/$/, "") : url.pathname === "/watch" ? url.searchParams.get("v") : PATH.exec(url.pathname)?.[1];
    if (!id || !ID.test(id)) return null;
    return { externalId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
  },
  fetch: ytdlpFetch,
};
