# Multi-stage build for NATS UI (frontend + backend API server)
FROM node:24-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build the frontend. Default NATS target can be baked in via build args
# (e.g. the docker-compose service reaches NATS at nats://nats:4222).
ARG VITE_NATS_URL
ARG VITE_NATS_HTTP_URL
ENV VITE_NATS_URL=$VITE_NATS_URL
ENV VITE_NATS_HTTP_URL=$VITE_NATS_HTTP_URL
COPY . .
RUN pnpm build

# Production stage: Node server that serves the built frontend and the API
FROM node:24-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only (includes hono, nats, tsx)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy the built frontend and the backend source
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY tsconfig.server.json ./

EXPOSE 3000

# Health check hits the backend health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["pnpm", "start"]
