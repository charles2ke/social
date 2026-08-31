# Social

AGPL-3.0 self-hosted social-media manager with a Next.js dashboard, Fastify API, and MCP server.

```text
Web (apps/web) ──► API (apps/api) ──► Core adapters/scheduler (packages/core)
MCP stdio server ───────────────────► Core adapters/scheduler
                                      └── PostgreSQL / Prisma (packages/db)
```

## Quick start

Requirements: Node.js 20+, [pnpm](https://pnpm.io) 9, and Docker.

1. Copy `.env.example` to `.env`, retain `MOCK_MODE=true`, and choose a 32-byte hex `ENCRYPTION_KEY`.
2. Start Postgres: `docker compose up -d postgres` (this also creates the
   least-privilege `social_worker` role automatically — see "Database"
   below).
3. Run `corepack pnpm install`, apply migrations with
   `corepack pnpm db:migrate`, then `corepack pnpm dev`.
4. Open http://localhost:3000. The API runs on port 3001. Use
   `docker compose up --build` to run everything (Postgres + the app) in
   containers with a single command.

Mock mode provides safe demo tokens/accounts and never contacts a platform,
so you get a working end-to-end demo with **no social platform credentials
configured**. Production deployments must use HTTPS, a strong `ADMIN_TOKEN`,
and platform credentials. Tokens are encrypted with AES-256-GCM before
persistence; errors must not include token values.

## Database

The persistence layer is **PostgreSQL, accessed through Prisma** — see
[`docs/adr/0001-database.md`](docs/adr/0001-database.md) for the full
security/reliability/performance rationale (short version: the DB stores
OAuth refresh tokens for 9 platforms and a background scheduler writes
concurrently with the web app, which is exactly the profile Postgres is
built for).

The Prisma schema, migrations, and scheduler claim-loop live in
[`packages/db`](packages/db).

### Running tests

```bash
pnpm test
```

Each test file in `packages/db` gets its own throwaway Postgres schema
(see `packages/db/test/setup.ts`), so tests can run against any bare
Postgres instance — including the one started by
`docker compose up -d postgres` above — with no hand-provisioned database
or seed data. CI provisions Postgres via a GitHub Actions service
container (see `.github/workflows/ci.yml`).

### Least-privilege worker role

`packages/db/prisma/init/01-social-worker-role.sql` creates a
`social_worker` Postgres role scoped to only what the scheduler needs:
read/write on `posts`, `platform_publish_attempts`, and
`analytics_snapshots`, read-only on `accounts` and `oauth_tokens`, and
nothing else. It's applied automatically by the `postgres` service on
first boot (mounted into `/docker-entrypoint-initdb.d`).

To have the scheduler worker connect using this role instead of the
default superuser, set `WORKER_DATABASE_URL` in `.env` to a connection
string using the `social_worker` role and have the worker process read
that variable instead of `DATABASE_URL`. Give the role a real password
out-of-band in production (`ALTER ROLE social_worker WITH PASSWORD '...'`)
— never commit one.

### Connection pooling

The Next.js app and the MCP server are separate processes and each open
their own Prisma connection pool. `packages/db`'s `createPrismaClient()`
sizes the pool from `DATABASE_CONNECTION_LIMIT` (default 5) — set this
per-consumer in each service's environment.

In production, put [PgBouncer](https://www.pgbouncer.org/) in front of
Postgres and point both consumers at it instead of the database directly.
When PgBouncer runs in transaction pooling mode, append `pgbouncer=true`
to `DATABASE_URL` so Prisma disables features that don't work with
statement-level pooling (see the commented example in `.env.example`).

## Platforms

| Platform | Publish API / scope | Media | Analytics | Note |
| --- | --- | --- | --- | --- |
| Instagram / Facebook | Meta Graph: `/me/accounts`, IG `media` + `media_publish` | image/video | yes | Register at [Meta](https://developers.facebook.com/docs/instagram-platform/content-publishing/). |
| WhatsApp | Cloud `/{phone-number-id}/messages` | template/text | no | Register [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). |
| LinkedIn | `/rest/posts`, `w_member_social` | image/video | yes | [LinkedIn apps](https://www.linkedin.com/developers/). |
| YouTube | Data API v3 resumable `videos.insert` | video | yes | [Google Cloud](https://console.cloud.google.com/). |
| TikTok | `/v2/post/publish/video/init/` | video | yes | [TikTok developers](https://developers.tiktok.com/). |
| Snapchat | Marketing/Creative API | — | — | Stub: creative publishing access is approval-limited. |
| Strava | `POST /api/v3/activities` | — | no | [Strava API](https://developers.strava.com/). |
| Substack | No public write API | — | no | Stub: export content as an email-ready draft; no scraping/automation. |

Set each client ID/secret in `.env` and configure callback URLs as
`https://your-host/api/oauth/<platform>/callback`. The adapters use typed
`UnsupportedOperation` errors for unavailable public writes and implement
rate-limit retry/backoff at the API boundary. Per-platform keys are documented
in `.env.example`.

## MCP

The MCP server shares `@social/core` with the web/API and exposes account,
draft, publishing, scheduling, status, and analytics tools plus
`social://accounts` and `social://posts/{id}` resources.

```json
{ "mcpServers": { "social": { "command": "node", "args": ["/absolute/path/to/social/packages/mcp-server/dist/mcp-server/src/index.js"], "env": { "MOCK_MODE": "true", "ENCRYPTION_KEY": "your-64-hex-character-key" } } } }
```

Use this in `claude_desktop_config.json` or VS Code MCP settings after
`corepack pnpm build`. It includes the `cross_platform_announcement` prompt.

## Development

`corepack pnpm lint`, `typecheck`, `test`, and `build` validate all workspaces.
The scheduler persists per-platform results (including errors), and its queue
supports cancellation and retries through the API/MCP surface.
