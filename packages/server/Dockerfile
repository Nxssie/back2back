# --- Builder: install deps, compile native modules, build web, fetch yt-dlp ---
FROM oven/bun:1 AS builder
WORKDIR /app

# Build tools in case a native module falls back to source compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libopus-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary — no Python runtime needed in the final image.
RUN curl -L -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    && chmod +x /usr/local/bin/yt-dlp

COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN bun install

# Build the web frontend (Vite) — output: packages/web/dist
COPY packages/web/ ./packages/web/
RUN cd packages/web && bun run build

# Server source (bun runs TS directly, no build step)
COPY packages/server/ ./packages/server/

# --- Runtime: minimal ---
FROM oven/bun:1-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libopus0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp binary fetched in the builder (no curl/python in the runtime image).
COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

# Expose the ffmpeg-static binary on PATH so yt-dlp's ffmpeg downloader
# fallback works without a second system ffmpeg install.
RUN ln -s /app/node_modules/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg

ENV NODE_ENV=production

EXPOSE 3001
CMD ["bun", "run", "--cwd", "packages/server", "start"]
