# Cob: plan

Self-hosted archiver for short-form videos. Send a link, get a stable page with the video, title, tags and transcript. Instagram reels first; other platforms plug in as providers. Built decisions: `DECISIONS.md`; how to run and extend: `README.md`.

## Prior art (researched 2026-10-29)
Nothing found that does link -> video + Whisper transcript -> own searchable page, self-hosted, maintained.
- **Karakeep**: bookmarks, AI tags, search; video download via yt-dlp is opt-in; no transcripts. Cob feeds it (see the sync in the README).
- **ArchiveBox / Tube Archivist / MeTube**: active, but no transcription and none plan it.
- **Small Instagram reel transcribers** (Curator, reels-vault, insta-reel-memory and similar): weeks old, single maintainer, no Wyoming, no per-reel page.
- **Building blocks**: yt-dlp, ffmpeg, `OHF-Voice/wyoming-faster-whisper`, Karakeep REST API.

## Pipeline
`submit -> classify + dedup -> download (provider) -> transcribe (Wyoming) -> save -> serve`
Each step records its status and is skipped on retry once done. Optional steps (transcript, Karakeep) never fail the reel.

## Platform seam
`Provider` in `src/core/types.ts`: `match(url)` returns `{externalId, canonicalUrl}` or null; `fetch(canonicalUrl, dir, ctx)` downloads into `dir`. Nothing outside `src/providers` names a platform.

## Risks
- Instagram often wants login: a cookies file from a throwaway account, and a current yt-dlp.
- The shared Wyoming GPU can run out of memory on long audio; Cob sends 25 s pieces with retries.
- Comments are fragile on Instagram, so they stay optional.

## Roadmap
1. **M1 (built)**: Instagram, queue, transcript, pages, search, tag filter.
2. **M2 (built)**: Karakeep sync (adds a Cob bookmark; optionally deletes the original).
3. **M3 (built)**: YouTube videos and Shorts.
4. **Next**: comments (`FetchedMedia.comments`, top N from env); FTS5 search; TikTok; PWA share target; duration from the audio when the platform omits it; an env filter for which platforms the Karakeep sync applies to.
