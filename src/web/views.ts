import type { Reel } from "../core/types.ts";

export const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Design: neutral surfaces, one accent for controls, 48 px tap targets, light and dark.
const CSS = `
:root{--bg:#f4f5f7;--surface:#fff;--text:#14181f;--muted:#4a5360;--line:#7b8491;--accent:#1f4fd1;--on-accent:#fff;--caution:#7a4d00;--caution-bg:#fff0c7;--warning:#a8201a;--warning-bg:#fde7e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1217;--surface:#171b22;--text:#e8ebf0;--muted:#a3acb9;--line:#717c8b;--accent:#8fb0ff;--on-accent:#0f1217;--caution:#f2b84b;--caution-bg:#3a2b0a;--warning:#ff9a92;--warning-bg:#45171a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1rem}h1{font-size:1.25rem;margin:.5rem 0}a{color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1rem;margin:1rem 0}
input,button{min-height:48px;border-radius:4px;font:inherit;border:1px solid var(--line);padding:0 .75rem;background:var(--surface);color:var(--text)}
input[type=url],input[type=search]{width:100%}button{background:var(--accent);color:var(--on-accent);border-color:var(--accent);cursor:pointer}
form.row{display:flex;gap:.5rem}form.row input{flex:1}
video{width:100%;max-height:75vh;background:#000;border-radius:4px}
.muted{color:var(--muted)}.tags a{display:inline-block;padding:.75rem .5rem}
.note{padding:.5rem .75rem;border-left:4px solid var(--caution);background:var(--caution-bg);margin:.5rem 0}
.note.bad{border-color:var(--warning);background:var(--warning-bg)}
.transcript{white-space:pre-wrap;margin:0}
ul.list{list-style:none;padding:0}ul.list li a{display:block;padding:.75rem 0;border-top:1px solid var(--line);text-decoration:none;color:inherit}
`;

export function layout(title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ""}<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

const statusLabel = (r: Reel) => (r.status === "done" ? "" : ` <span class="muted">[${r.status}]</span>`);

export function indexPage(reels: Reel[], q: string, tag: string, error?: string): string {
  const items = reels.map((r) => `<li><a href="/k/${esc(r.id)}">${esc(r.title ?? r.originalUrl)}${statusLabel(r)}<br><span class="muted">${esc(r.platform)}${r.author ? " · " + esc(r.author) : ""}</span></a></li>`).join("");
  return layout("Cob", `<h1>Cob</h1>
${error ? `<p class="note bad" role="alert">${esc(error)}</p>` : ""}
<form class="row" method="post" action="/submit"><input type="url" name="url" placeholder="Paste a link" aria-label="Link" required><button>Archive</button></form>
<form class="row" method="get" action="/" style="margin-top:.5rem"><input type="search" name="q" value="${esc(q)}" placeholder="Search title, tags, transcript" aria-label="Search">${tag ? `<input type="hidden" name="tag" value="${esc(tag)}">` : ""}<button>Search</button></form>
${tag ? `<p>Tag: #${esc(tag)} · <a href="/">clear</a></p>` : ""}
<ul class="list">${items || '<li class="muted">Nothing archived yet.</li>'}</ul>`);
}

const SOURCE_LABEL = { subtitles: "From the video's subtitles", "auto-captions": "From auto-generated captions", whisper: "Transcribed with Whisper" } as const;

export function reelPage(r: Reel, full = true): string {
  const pending = r.status === "queued" || r.status === "running";
  const tags = r.tags.map((t) => `<a href="/?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join(" ");
  const video = r.videoPath ? `<video controls playsinline preload="metadata" src="/media/${esc(r.id)}"></video>` : "";
  let transcript: string;
  if (r.transcript) transcript = `<p class="transcript">${esc(r.transcript)}</p>`;
  else if (r.transcriptStatus === "done") transcript = `<p class="muted">No speech detected.</p>`;
  else if (r.transcriptStatus === "failed") transcript = `<p class="note bad">Transcription failed: ${esc(r.transcriptError)}</p>`;
  else if (r.transcriptStatus === "skipped") transcript = `<p class="note">Not transcribed: ${esc(r.transcriptError)}</p>`;
  else transcript = `<p class="muted">Waiting…</p>`;
  return layout(r.title ?? "Saved", `${full ? '<p><a href="/">← All saved</a></p>' : ""}
<h1>${esc(r.title ?? "Archiving…")}</h1>
${pending ? `<p class="note" role="status">${r.status === "queued" ? "Queued" : "Downloading"}… this page refreshes.</p>` : ""}
${r.status === "failed" ? `<p class="note bad" role="alert">Failed: ${esc(r.error)}</p>` : ""}
${video}
<p class="muted">${esc(r.platform)}${r.author ? " · " + esc(r.author) : ""}${r.durationS ? ` · ${r.durationS} s` : ""} · <a href="${esc(r.canonicalUrl)}" rel="noreferrer noopener">original link</a></p>
${tags ? `<p class="tags">${tags}</p>` : ""}
${r.caption ? `<div class="card"><h2>Caption</h2><p class="transcript">${esc(r.caption)}</p></div>` : ""}
<div class="card"><h2>Transcript</h2>${r.transcript && r.transcriptSource ? `<p class="muted">${SOURCE_LABEL[r.transcriptSource]}</p>` : ""}${transcript}</div>
${full && !pending ? `<form method="post" action="/k/${esc(r.id)}/retry"><button>Retry</button></form>` : ""}`, pending);
}

export function notFoundPage(): string {
  return layout("Not found", `<h1>Not found</h1><p><a href="/">← All saved</a></p>`);
}
