# social
Social Media Manager

Manage and publish to 9 social platforms (Instagram, Facebook, WhatsApp,
LinkedIn, Substack, YouTube, Snapchat, TikTok, Strava) from one place, with
a background scheduler and an MCP server for programmatic access.

> This repository is being built out incrementally. This README currently
> documents the persistence layer; the rest of the app scaffold (web app,
> MCP server) is being added separately.

## Database

The persistence layer is **PostgreSQL, accessed through Prisma** — see
[`docs/adr/0001-database.md`](docs/adr/0001-database.md) for the full
security/reliability/performance rationale (short version: the DB stores
OAuth refresh tokens for 9 platforms and a background scheduler writes
concurrently with the web app, which is exactly the profile Postgres is
built for).

The Prisma schema, migrations, and scheduler claim-loop live in
[`packages/db`](packages/db).

### Local setup

Requirements: Node.js 20+, [pnpm](https://pnpm.io) 9, and Docker.

```bash
cp .env.example .env

# Starts Postgres (packages/db/prisma/init/*.sql runs automatically on
# first boot, creating the least-privilege social_worker role).
docker compose up -d postgres

pnpm install
pnpm --filter @social/db exec prisma migrate deploy
pnpm --filter @social/db run generate
```

`docker compose up` is a single command — no manual database creation or
migration step is required beyond the `prisma migrate deploy` above (which
will itself be wired into each app service's start script as the rest of
the scaffold lands).

### Running tests

```bash
pnpm test
```

Each test file gets its own throwaway Postgres schema (see
`packages/db/test/setup.ts`), so tests can run against any bare Postgres
instance — including the one started by `docker compose up -d postgres`
above — with no hand-provisioned database or seed data. CI provisions
Postgres via a GitHub Actions service container (see
`.github/workflows/ci.yml`).

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

### Mock mode

Set `MOCK_MODE=true` (the default in `.env.example`) to run the full
create → schedule → publish flow against local mocks instead of real
platform APIs. No OAuth app registration or credentials for any of the 9
platforms are required to see an end-to-end demo.

