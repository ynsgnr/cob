# syntax=docker/dockerfile:1
# No build step and no npm dependencies: Node 24 runs the TypeScript directly.
FROM node:24-bookworm-slim
ARG YTDLP_VERSION=2026.10.26
# yt-dlp is pinned and verified against the SHA2-256SUMS published with the release. Bump YTDLP_VERSION often: Instagram and YouTube break old versions.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && cd /tmp && R="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}" && curl -fsSLO "$R/yt-dlp" -O "$R/SHA2-256SUMS" \
 && grep ' yt-dlp$' SHA2-256SUMS | sha256sum -c - \
 && install -m 0755 yt-dlp /usr/local/bin/yt-dlp && rm -f yt-dlp SHA2-256SUMS \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/data/media DATABASE_PATH=/data/cob.db
RUN mkdir /data && chown node:node /data
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "src/main.ts"]
