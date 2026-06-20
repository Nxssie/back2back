FROM oven/bun:1 AS builder
WORKDIR /app

# Copy all workspace manifests so bun can resolve the full monorepo lockfile.
# --ignore-scripts skips native builds (e.g. @discordjs/opus) that the web
# builder doesn't need and can't compile without extra system deps.
COPY package.json bun.lock* ./
COPY packages/web/package.json ./packages/web/
COPY packages/server/package.json ./packages/server/
RUN bun install --ignore-scripts

# Copy source and build
COPY packages/web/ ./packages/web/
RUN cd packages/web && bun run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
