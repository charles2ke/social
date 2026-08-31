# ADR 0001: Use PostgreSQL (via Prisma) as the persistence layer

- Status: Accepted
- Date: 2026-08-31

## Context

The application stores connected social accounts, AES-256-GCM-encrypted
OAuth refresh/access tokens for 9 platforms (Instagram, Facebook, WhatsApp,
LinkedIn, Substack, YouTube, Snapchat, TikTok, Strava), post drafts, the
scheduled-post queue, per-platform publish attempts/results, and cached
analytics. A background scheduler worker polls for due posts and publishes
them while the web app concurrently accepts new drafts and OAuth callbacks
write refreshed tokens.

We needed to choose both a database engine and an ORM/migration tool.

## Decision

Use **PostgreSQL** as the runtime database, accessed through **Prisma**.

### Why PostgreSQL over SQLite

**Security** — the database holds OAuth refresh tokens for 9 platforms.
Even with app-layer AES-256-GCM encryption, defense-in-depth argues for a
database that can enforce least privilege: the scheduler worker should not
need the same grants as the OAuth callback handler. Postgres gives us a
real role/privilege system (see `social_worker` in
`packages/db/prisma/init/01-social-worker-role.sql`), TLS-enforced
connections (`sslmode=require`), and `pgcrypto`/TDE options as additional
defense-in-depth layers. SQLite only offers filesystem permissions — any
process that can read the file can read every token in it.

**Reliability** — SQLite serializes writers. Our architecture has a
background scheduler publishing due posts while OAuth callbacks persist
refreshed tokens; that write-contention pattern produces `SQLITE_BUSY`
errors even under WAL mode. Postgres's MVCC means readers never block
writers. Critically, the scheduler's claim-loop
(`SELECT ... FOR UPDATE SKIP LOCKED`, see `packages/db/src/scheduler.ts`)
requires row-level locking with lock-skipping semantics so that multiple
worker instances can safely claim due posts without double-publishing —
SQLite has no equivalent, which would cap us at exactly one worker forever.
Postgres also gives PITR and streaming replication for backups, versus
"copy the file and hope nothing was mid-write."

**Performance** — for single-user reads, SQLite genuinely wins (no network
hop); we don't dispute that. But the real workload here is write-heavy
under concurrency: token refreshes, per-platform publish status rows,
retries, and analytics polling. That's exactly where Postgres's MVCC wins,
and connection pooling (PgBouncer) lets the Next.js app and the MCP server
share capacity as two separate consumers without correctness hazards.

### Why Prisma over Drizzle

The schema is meaningfully relational — accounts → tokens → posts →
per-platform publish attempts → analytics — and Prisma's migration tooling
and generated types are stronger for that shape than Drizzle's. Drizzle is
leaner and has lower runtime overhead, which matters more in cold-start-
sensitive edge environments; this project isn't one. Prisma's
`$transaction` API with explicit isolation levels is also what the
scheduler's claim-loop needs (see `claimDuePosts` in
`packages/db/src/scheduler.ts`, run at `ReadCommitted` isolation).

## Rejected alternatives

- **SQLite** — rejected for the reliability and security reasons above.
  Kept in mind as a "simple to start" option, but the scheduler's
  concurrency requirements and the sensitivity of the stored OAuth tokens
  make it the wrong choice here.
- **Drizzle** — a reasonable alternative ORM, but Prisma's stronger
  migration tooling and generated types were judged more valuable for this
  relational schema than Drizzle's lower runtime overhead.

## Consequences

- **Conceded tradeoff**: Postgres raises local setup friction compared to
  a zero-config SQLite file. We offset this by shipping a `postgres:16-alpine`
  service in `docker-compose.yml` with a health check, so `docker compose up`
  remains a single command with no manual database setup.
- Tests use a throwaway Postgres schema per test file (see
  `packages/db/test/setup.ts`) rather than SQLite, because the schema
  itself is Postgres-only (native enums, `JSONB`, `TIMESTAMPTZ`, and the
  `FOR UPDATE SKIP LOCKED` concurrency test cannot be emulated on SQLite).
  CI provisions Postgres via a GitHub Actions service container — no
  hand-provisioned database is required to run the test suite.
- Production deployments should run behind PgBouncer in transaction mode
  and append `pgbouncer=true` to `DATABASE_URL`; see `README.md`
  "Connection pooling".
