-- Least-privilege role for the scheduler worker process.
--
-- This script is mounted into the Postgres container's
-- /docker-entrypoint-initdb.d/ so it runs once, automatically, the first
-- time the `postgres` service starts against an empty data volume. See
-- README.md "Least-privilege worker role" for how to point the scheduler
-- at this role via WORKER_DATABASE_URL.
--
-- It only creates the role. Init scripts run before any migration, so the
-- tables don't exist yet: their privileges are granted by the migration
-- prisma/migrations/20261001000000_social_worker_grants (or, if the role is
-- created after migrating, by `pnpm --filter @social/db run grant:worker`).
--
DO
$$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'social_worker') THEN
    -- A production password must be managed out of band, never committed.
    CREATE ROLE social_worker WITH LOGIN;
  END IF;
END
$$;

-- Allow the role to connect and use the schema, but grant nothing by default.
DO
$$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO social_worker', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO social_worker;
