import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll } from "vitest";

/**
 * Gives every test file its own throwaway Postgres schema, applied from the
 * committed migration SQL. This means:
 *   - tests never require a hand-provisioned database (any bare Postgres
 *     instance/service-container works, see .github/workflows/ci.yml)
 *   - test files can run in parallel without clobbering each other's data
 *   - the concurrency test can rely on real Postgres row locking semantics
 *     (`FOR UPDATE SKIP LOCKED`), which SQLite cannot emulate.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "prisma", "migrations");

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

const schemaName = `test_${randomBytes(6).toString("hex")}`;
let adminClient: Client;

export function testDatabaseUrl(): string {
  const url = new URL(baseDatabaseUrl());
  url.searchParams.set("schema", schemaName);
  return url.toString();
}

beforeAll(async () => {
  adminClient = new Client({ connectionString: baseDatabaseUrl() });
  await adminClient.connect();
  await adminClient.query(`CREATE SCHEMA "${schemaName}"`);
  await adminClient.query(`SET search_path TO "${schemaName}"`);
  await adminClient.query(loadMigrationSql());
});

afterAll(async () => {
  await adminClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminClient.end();
});
