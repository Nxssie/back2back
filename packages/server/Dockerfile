FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies (yt-dlp, ffmpeg)
RUN apt-get update && apt-get install -y \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install yt-dlp

# Copy workspace manifests so bun can resolve the monorepo lockfile
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
RUN bun install --frozen-lockfile

# Copy source
COPY packages/server/ ./packages/server/

# Migrations are applied at startup against the mounted volume (see src/db),
# not baked into the image at build time.
EXPOSE 3001
CMD ["bun", "run", "--cwd", "packages/server", "start"]
