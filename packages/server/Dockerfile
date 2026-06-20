FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies (yt-dlp, ffmpeg)
RUN apt-get update && apt-get install -y \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install yt-dlp

# Install dependencies
COPY packages/server/package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY packages/server/ .

# Migrations are applied at startup against the mounted volume (see src/db),
# not baked into the image at build time.
EXPOSE 3001
CMD ["bun", "run", "start"]
