# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/

# Build the application
RUN pnpm run build

# Prune dev dependencies
RUN pnpm prune --prod

# ---- Production stage ----
FROM node:22-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

# Security: run as non-root user
RUN addgroup --system --gid 1001 appgroup &&     adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=build --chown=appuser:appgroup /app/dist ./dist
COPY --from=build --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /app/package.json ./
COPY --from=build --chown=appuser:appgroup /app/drizzle.config.ts ./

# Copy migrations if they exist
COPY --from=build --chown=appuser:appgroup /app/src/db/migrations ./src/db/migrations

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3   CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
