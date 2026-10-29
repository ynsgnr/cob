# Cob: agent contract

Self-hosted short-video archiver. Node 24 (runs TypeScript directly, no build), `node:sqlite`, `node:http`, `node:test`. No runtime npm dependencies. Plan: `PLAN.md`; decisions: `DECISIONS.md`.
Spec of record: `src/core/types.ts` (Reel, Provider, FetchedMedia).

## Where things are
- Provider (one per platform): `src/providers/<id>.ts` + a case in `tests/providers.test.ts`; register in `src/providers/index.ts`. yt-dlp-backed ones reuse `ytdlpFetch` from `src/providers/ytdlp.ts`.
- Pipeline (fetch -> transcribe -> save, resumable per step): `src/worker/pipeline.ts`; queue loop: `src/worker/worker.ts`.
- Transcription: `src/transcribe` (ffmpeg to PCM, Wyoming client).
- DB: `src/db/index.ts` (schema, `CREATE IF NOT EXISTS`; schema changes are appended to `MIGRATIONS` (never edit an old entry; `user_version` tracks them)), all queries in `src/db/reels.ts`.
- Web: `src/web/server.ts` (routes), `src/web/views.ts` (HTML; neutral colours, one accent, 48 px tap targets, light and dark).
- Karakeep sync: `src/integrations/karakeep.ts` (client + `syncOnce`), state in `src/db/karakeep.ts`. Tests use an in-memory fake client.
- Config: `src/config.ts` (env only). `.env.example` lists every variable.

## Rules
- Files under ~200 lines, short direct code, comments only for non-obvious logic. No new dependencies without need.
- Pipeline, DB and UI never name a platform. Platform logic lives only in a provider.
- Submitted URLs are untrusted: only a provider that matched may touch them, and only its rebuilt `canonicalUrl` goes to yt-dlp. Media is served by reel id from the DB, never from a request path. File paths go through `mediaPath()`.
- An optional step (transcript, later comments and Karakeep push) never fails the reel; record its status and error on the row.
- Escape all output (`esc()`); no inline scripts (CSP forbids them).
- Secrets and cookies only via env/files outside the repo, never logged.
- Tests use fakes (`tests/helpers.ts`); no network. Commands: `npm test`, `npm run typecheck`.
