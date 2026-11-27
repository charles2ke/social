import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./setup.js";

const grantsSql = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", "20261001000000_social_worker_grants", "migration.sql"),
  "utf8",
);

const url = new URL(testDatabaseUrl());
const schema = url.searchParams.get("schema")!;
url.searchParams.delete("schema");
const client = new Client({ connectionString: url.toString() });

beforeAll(async () => {
  await client.connect();
  // Roles are cluster-wide; this is the same idempotent statement the init script runs.
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'social_worker') THEN CREATE ROLE social_worker; END IF; END $$`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(grantsSql);
});

afterAll(async () => {
  await client.end();
});

async function can(privilege: string, table: string, column?: string): Promise<boolean> {
  const target = `"${schema}"."${table}"`;
  const { rows } = column
    ? await client.query<{ ok: boolean }>("SELECT has_column_privilege('social_worker', $1, $2, $3) AS ok", [target, column, privilege])
    : await client.query<{ ok: boolean }>("SELECT has_table_privilege('social_worker', $1, $2) AS ok", [target, privilege]);
  return rows[0]!.ok;
}

describe("social_worker grants", () => {
  it("lets the worker run the claim loop and record results, but not create or delete posts", async () => {
    expect(await can("SELECT", "posts")).toBe(true);
    expect(await can("UPDATE", "posts")).toBe(true);
    expect(await can("INSERT", "posts")).toBe(false);
    expect(await can("DELETE", "posts")).toBe(false);
    expect(await can("INSERT", "platform_publish_attempts")).toBe(true);
    expect(await can("UPDATE", "platform_publish_attempts")).toBe(true);
    expect(await can("DELETE", "platform_publish_attempts")).toBe(false);
  });

  it("only lets the worker rewrite token columns of existing token rows", async () => {
    expect(await can("SELECT", "oauth_tokens")).toBe(true);
    expect(await can("UPDATE", "oauth_tokens", "encrypted_access_token")).toBe(true);
    expect(await can("UPDATE", "oauth_tokens", "account_id")).toBe(false);
    expect(await can("INSERT", "oauth_tokens")).toBe(false);
    expect(await can("DELETE", "oauth_tokens")).toBe(false);
    expect(await can("SELECT", "accounts")).toBe(true);
    expect(await can("UPDATE", "accounts")).toBe(false);
    expect(await can("SELECT", "analytics_snapshots")).toBe(false);
  });
});
