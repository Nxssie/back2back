FROM oven/bun:1 AS builder
WORKDIR /app

# Install dependencies
COPY packages/web/package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY packages/web/ .

# Build
RUN bun run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
