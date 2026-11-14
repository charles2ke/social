import { defineConfig, devices } from "@playwright/test";
import { apiOrigin, apiPort, docsScreenshots, webOrigin, webPort } from "./e2e/servers";

/**
 * End-to-end tests drive the production build of the dashboard against the
 * API in mock mode with in-memory storage, so they need neither a database
 * nor platform credentials.
 */

// README screenshots must come from a fresh mock API and production build, never a running dev server.
const reuseExistingServer = !process.env.CI && !docsScreenshots;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // Every test talks to the same in-memory API, so they run one at a time.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: webOrigin, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: [
    {
      name: "api",
      command: "pnpm --filter @social/core run build && pnpm --filter @social/api exec tsx src/index.ts",
      url: `${apiOrigin}/health`,
      // Blank values override anything inherited from the shell, keeping the API in mock + memory mode.
      env: { MOCK_MODE: "true", API_PORT: String(apiPort), WEB_ORIGIN: webOrigin, DATABASE_URL: "", ADMIN_TOKEN: "" },
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "web",
      command: `pnpm exec next build && pnpm exec next start --port ${webPort}`,
      url: webOrigin,
      env: { NEXT_PUBLIC_API_URL: apiOrigin, NEXT_STATIC_EXPORT: "", NEXT_BASE_PATH: "" },
      reuseExistingServer,
      timeout: 240_000,
    },
  ],
});
