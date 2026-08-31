import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll } from "vitest";

/**
 * Gives this test file its own throwaway Postgres schema, applied from the
 * committed `@social/db` migration SQL — mirrors
 * `packages/db/test/setup.ts` so `apps/api` can be tested against a bare
 * Postgres instance with no hand-provisioned database or seed data.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "db",
  "prisma",
  "migrations",
);

function baseDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://social@localhost:5432/social"
  );
}

function loadMigrationSql(): string {
  const migrationFolders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return migrationFolders
    .map((folder) =>
      readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8"),
    )
    .join("\n");
}

const schemaName = `test_api_${randomBytes(6).toString("hex")}`;
const resolvedBaseUrl = baseDatabaseUrl();

function schemaUrl(): string {
  const url = new URL(resolvedBaseUrl);
  url.searchParams.set("schema", schemaName);
  return url.toString();
}

// `getPrismaClient()` (used by apps/api's `store.ts`/`app.ts`) is a
// process-wide singleton that reads `DATABASE_URL` the first time it's
// constructed, so it must already point at this file's throwaway schema
// before those modules are imported. Vitest evaluates `setupFiles` before
// the test file's own imports, so setting it here (synchronously, at
// module load) is safe.
process.env.DATABASE_URL = schemaUrl();
process.env.ENCRYPTION_KEY ??= "a".repeat(64);

let adminClient: Client;

beforeAll(async () => {
  adminClient = new Client({ connectionString: resolvedBaseUrl });
  await adminClient.connect();
  await adminClient.query(`CREATE SCHEMA "${schemaName}"`);
  await adminClient.query(`SET search_path TO "${schemaName}"`);
  await adminClient.query(loadMigrationSql());
});

afterAll(async () => {
  await adminClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminClient.end();
});
