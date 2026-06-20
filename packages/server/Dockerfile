FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies (yt-dlp, ffmpeg, libopus for @discordjs/opus)
RUN apt-get update && apt-get install -y \
    python3-pip \
    ffmpeg \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages yt-dlp

# Copy all workspace manifests so bun can resolve the full monorepo lockfile
COPY package.json bun.lock* ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN bun install

# Copy source
COPY packages/server/ ./packages/server/

# Migrations are applied at startup against the mounted volume (see src/db),
# not baked into the image at build time.
EXPOSE 3001
CMD ["bun", "run", "--cwd", "packages/server", "start"]
