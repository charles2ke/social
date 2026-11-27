# syntax=docker/dockerfile:1

# One image for every service in docker-compose.yml: the migration job, the
# API, the dashboard and the scheduler worker each run a different command.

FROM node:22-alpine AS build
# Prisma needs OpenSSL to pick and load its engine on Alpine.
RUN apk add --no-cache openssl
WORKDIR /app
RUN corepack enable
# Download dependencies from the lockfile alone, so this layer stays cached until it changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# The dashboard bakes the API URL into its browser bundle and its CSP at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --offline --frozen-lockfile \
 && pnpm --filter @social/db run generate \
 && pnpm build

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1
# The code stays owned by root so the app user cannot change it; only the dashboard's cache is writable.
COPY --from=build /app /app
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000 3001
CMD ["node", "apps/api/dist/apps/api/src/index.js"]
