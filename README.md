# Cob

Send a link to a short video, get back a page with the video (stored on disk), title, tags and a Whisper transcript. Supports Instagram reels, YouTube videos and YouTube Shorts; other platforms plug in as providers. Built to feed [Karakeep](https://karakeep.app): save a link there and it becomes a searchable, offline copy. See `PLAN.md` for the roadmap and `DECISIONS.md` for why it is built this way.

> **Read this before you deploy.** Cob has **no login, by design**: it is a small single-user service. Run it behind a reverse proxy or auth layer. The only paths that may be public are the per-video pages `GET /k/<id>` and `GET /media/<id>` (Karakeep needs those); everything else (`/`, `/submit`, `/api/*`, retry) lets whoever reaches it queue downloads on your disk, bandwidth and GPU, so keep it behind your login.
>
> **Personal archiving only.** Downloading from Instagram or YouTube goes against their terms, and the `/k/<id>` pages serve full copies of other people's videos to anyone holding the link. Cob sends `noindex` headers, but do not run a public instance that re-hosts content.

## Use
- Open `/`, paste a link, press Archive. You land on `/k/<id>`, which refreshes until done.
- `POST /api/reels {"url": "..."}` (`content-type: application/json`) returns `{id, url, status, created}`; `GET /api/reels/<id>` returns the reel as JSON. Resubmitting a known video returns the existing one.
- `/?q=text` searches title, caption, transcript, tags, author. `/?tag=pasta` filters by tag.
- Pages used to live under `/r/<id>`; those links redirect to `/k/<id>`.

## Run locally
Needs Node 24 (it uses the built-in `node:sqlite`, which Node may still flag as experimental), `yt-dlp` and `ffmpeg` on PATH.
```
npm install && cp .env.example .env   # then export the variables, or use `node --env-file=.env src/main.ts`
npm test && npm run typecheck
npm start
```
A `Dockerfile` is included (no build step; yt-dlp is pinned and checksum-verified, bump `YTDLP_VERSION` often because Instagram and YouTube break old versions).

Every variable is documented in `.env.example`. The ones you usually need: `WYOMING_URL` (a [Wyoming](https://github.com/OHF-Voice/wyoming-faster-whisper) whisper server; unset = no transcription), `YTDLP_COOKIES_FILE` (Instagram usually needs it), `MEDIA_DIR`, `DATABASE_PATH`, and the Karakeep variables below.

- **Instagram:** failures show on the page. "Wants a logged-in session" means export cookies from a throwaway account's browser session and set `YTDLP_COOKIES_FILE`; if that does not help, update yt-dlp.
- **YouTube:** yt-dlp runs with `--js-runtimes node` (Node is already there). Videos over 1 hour or 200 MB are refused, and downloads are capped at 720p (H.264/AAC). Playlists and channels are not matched; a `watch?v=…&list=…` link archives just that video. The cookies file is shared by all providers (yt-dlp only sends each site its own cookies); YouTube usually works without it.

## Karakeep integration (optional)
**The idea: you never open Cob.** Save a reel or a YouTube video in Karakeep the way you save any link (share sheet, browser extension, paste). Cob works in the background and Karakeep gets an archived copy. No second app to check.

What you see in Karakeep:
1. You save `https://www.instagram.com/reel/…` as usual. For a minute or two it is a normal bookmark.
2. Cob notices it, downloads the video and transcribes it. Nothing changes on your side.
3. A bookmark to the Cob page for that video appears (title and your note carried over). It is just another bookmark: it shows up in your lists and searches, and Karakeep tags it like any other page.
4. Search in Karakeep now finds the video by what is said in it, because the transcript is on the page Karakeep reads. Open the bookmark to watch the stored video and read the transcript, with a link back to the original.

By default the original bookmark stays, so you end up with both. Set `KARAKEEP_REPLACE=true` and Cob deletes the original once the Cob bookmark exists, so each video is a single bookmark. Deleting loses the original's tags, lists and favourite/archived state, so back up Karakeep and try it on a few links first.

Setup: set `KARAKEEP_API_KEY` (Karakeep -> User Settings -> API Keys; a key with the `bookmarks:readwrite` scope should be enough), `KARAKEEP_URL` and `PUBLIC_BASE_URL` (where Karakeep and you reach Cob, no trailing slash). Then every minute Cob:
1. lists your newest Karakeep bookmarks and picks new links a provider understands (Instagram reels, YouTube videos and Shorts);
2. archives and transcribes them like a submitted link;
3. once done, adds a Karakeep bookmark to `PUBLIC_BASE_URL/k/<id>` and, with `KARAKEEP_REPLACE=true`, deletes the original.

- Only links added after Cob first ran with the integration are handled. `KARAKEEP_BACKFILL=true` also handles older ones (that downloads your whole backlog, slowly).
- If the download or transcript fails the original stays; retry on the Cob page and the next poll continues.
- This applies to every supported platform.
- Turn off Karakeep's own video download (`CRAWLER_VIDEO_DOWNLOAD`) for Cob links; the page already has the video.
- Karakeep's crawler must be able to open `PUBLIC_BASE_URL/k/<id>` without logging in (see the warning at the top).

## Add a platform
Write `src/providers/<id>.ts` exporting a `Provider` (`match(url)` returns `{externalId, canonicalUrl}` or null, `fetch` downloads into a directory; for yt-dlp sites call `ytdlpFetch`), add it to `src/providers/index.ts`, add tests. Nothing else changes.

## Dev loop on Kubernetes (optional)
`devspace.yaml` and `deploy/devspace/` sync the working tree into a stock Node pod and run `node --watch`. Edit `WYOMING_URL` in `deploy/devspace/app.yaml`, optionally put a cookies file at `~/.config/cob/cookies.txt` (`deploy/devspace/secrets.sh` turns it into a Secret), then run `devspace dev`. The pod fetches yt-dlp and a static ffmpeg on first start (`deploy/devspace/tools.sh`).

## License
[AGPL-3.0-only](LICENSE). If you run a modified version for others over a network, you must offer them your source.
