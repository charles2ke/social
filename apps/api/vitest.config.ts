import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own throwaway Postgres schema (see
    // test/setup.ts), mirroring packages/db's test setup, so tests can run
    // against any bare Postgres instance with no hand-provisioned database.
    fileParallelism: true,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
  },
});
