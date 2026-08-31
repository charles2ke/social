-- Least-privilege role for the scheduler worker process.
--
-- The worker only needs to:
--   * read/update `posts` (claim-loop) and `platform_publish_attempts`
--   * read `accounts` (to know which platform/account a post targets)
--   * read (never write) `oauth_tokens`, and only the columns it needs to
--     make an authenticated publish call — it must never be able to grant
--     itself broader token access than the OAuth callback handler has.
--
-- This script is mounted into the Postgres container's
-- /docker-entrypoint-initdb.d/ so it runs once, automatically, the first
-- time the `postgres` service starts against an empty data volume. See
-- README.md "Least-privilege worker role" for how to point the scheduler
-- at this role via WORKER_DATABASE_URL.
--
-- NOTE: the password below is a local-dev-only placeholder. Production
-- deployments must set a strong, secret-managed password (e.g. via
-- ALTER ROLE ... PASSWORD, applied out-of-band, never committed).

DO
$$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'social_worker') THEN
    CREATE ROLE social_worker WITH LOGIN PASSWORD 'change-me-in-production';
  END IF;
END
$$;

-- Allow the role to connect and use the schema, but grant nothing by default.
GRANT CONNECT ON DATABASE social TO social_worker;
GRANT USAGE ON SCHEMA public TO social_worker;

-- Scheduler needs full read/write on the job queue tables it owns the
-- lifecycle of.
GRANT SELECT, INSERT, UPDATE ON public.posts TO social_worker;
GRANT SELECT, INSERT, UPDATE ON public.platform_publish_attempts TO social_worker;
GRANT SELECT, INSERT ON public.analytics_snapshots TO social_worker;

-- Read-only visibility into which account a post/attempt targets.
GRANT SELECT ON public.accounts TO social_worker;

-- Read-only access to encrypted token material so it can make publish
-- calls; it must never be able to INSERT/UPDATE/DELETE tokens (that stays
-- the OAuth callback handler's job, run under the app's own role).
GRANT SELECT ON public.oauth_tokens TO social_worker;

-- No sequence/table creation, no DDL, no access to any future tables
-- unless explicitly granted above.
