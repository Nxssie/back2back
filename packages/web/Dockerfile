FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace manifests so bun can resolve the monorepo lockfile
COPY package.json bun.lock* ./
COPY packages/web/package.json ./packages/web/
RUN bun install --frozen-lockfile

# Copy source and build
COPY packages/web/ ./packages/web/
RUN cd packages/web && bun run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
