import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own throwaway Postgres schema (see
    // test/setup.ts) so tests can run in parallel without a
    // hand-provisioned database — CI just needs a bare Postgres service
    // container (see .github/workflows/ci.yml).
    fileParallelism: true,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
  },
});
