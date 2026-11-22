-- Privileges for the least-privilege scheduler worker role (`social_worker`,
-- created by prisma/init/01-social-worker-role.sql or by an operator).
--
-- They live in a migration rather than in the Postgres init script because
-- init scripts run before any migration, when these tables don't exist yet.
-- Deployments without the role skip this; if the role is created later, run
-- `pnpm --filter @social/db run grant:worker` to apply the same grants.
--
-- The worker only needs to:
--   * read and update `posts` (claim loop) — it never creates them
--   * record per-platform results in `platform_publish_attempts`
--   * read `accounts`, to know which account a post targets
--   * read `oauth_tokens`, and update only the token columns of an existing
--     row when a publish refreshes an expired access token. It can never
--     create or delete token rows (connect and disconnect run as the API).
DO
$$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'social_worker') THEN
    GRANT SELECT, UPDATE ON "posts" TO social_worker;
    REVOKE INSERT, DELETE ON "posts" FROM social_worker;
    GRANT SELECT, INSERT, UPDATE ON "platform_publish_attempts" TO social_worker;
    GRANT SELECT ON "accounts" TO social_worker;
    GRANT SELECT ON "oauth_tokens" TO social_worker;
    GRANT UPDATE ("encrypted_access_token", "encrypted_refresh_token", "expires_at", "updated_at") ON "oauth_tokens" TO social_worker;
    -- Nothing in the worker reads or writes analytics.
    REVOKE ALL ON "analytics_snapshots" FROM social_worker;
  END IF;
END
$$;
