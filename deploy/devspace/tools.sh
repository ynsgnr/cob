#!/usr/bin/env bash
# Dev pod only (stock node image, non-root): fetch yt-dlp (pinned, checksum-verified) and a static ffmpeg into $TOOLS once.
# Production uses the Dockerfile instead.
set -euo pipefail
T="${TOOLS:-/data/bin}"; V="${YTDLP_VERSION:-2026.10.26}"; mkdir -p "$T"
if [ ! -x "$T/yt-dlp" ]; then
  R="https://github.com/yt-dlp/yt-dlp/releases/download/$V"; W=$(mktemp -d)
  curl -fsSL "$R/yt-dlp" -o "$W/yt-dlp" && curl -fsSL "$R/SHA2-256SUMS" -o "$W/SUMS"
  (cd "$W" && grep ' yt-dlp$' SUMS | sha256sum -c -) && install -m 0755 "$W/yt-dlp" "$T/yt-dlp"; rm -rf "$W"
fi
# ffmpeg is a static build from johnvansickle.com, not checksum-verified here.
if [ ! -x "$T/ffmpeg" ]; then
  curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C "$T" --strip-components=1 --wildcards '*/ffmpeg'
fi
