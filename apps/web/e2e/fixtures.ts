import { type APIRequestContext, expect, test as base } from "@playwright/test";
import { adminToken, apiOrigin } from "./servers";

type Session = { token: string; expiresAt: string };

/** Where the dashboard keeps its session (apps/web/app/session.ts). */
export const sessionKey = "social.session";

/**
 * Tests start signed in with a real session, minted once per worker so the
 * sign-in rate limit is not spent on setup. `test.use({ signedIn: false })`
 * starts at the sign-in form instead.
 */
export const test = base.extend<{ signedIn: boolean; api: APIRequestContext }, { session: Session }>({
  session: [
    async ({ playwright }, use) => {
      const context = await playwright.request.newContext();
      const response = await context.post(`${apiOrigin}/auth/session`, { data: { token: adminToken } });
      expect(response.status(), "signing in to the e2e API").toBe(201);
      await use((await response.json()) as Session);
      await context.dispose();
    },
    { scope: "worker" },
  ],
  signedIn: [true, { option: true }],
  page: async ({ page, signedIn, session }, use) => {
    if (signedIn) {
      await page.addInitScript(
        ([key, value]) => {
          if (!window.sessionStorage.getItem(key)) window.sessionStorage.setItem(key, value);
        },
        [sessionKey, JSON.stringify(session)] as const,
      );
    }
    // The dashboard sends a Content-Security-Policy; anything it blocks is a bug.
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Content Security Policy")) violations.push(message.text());
    });
    await use(page);
    expect(violations, "Content-Security-Policy violations").toEqual([]);
  },
  /** The API as scripts and the MCP server call it: with ADMIN_TOKEN as the bearer token. */
  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: apiOrigin, extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` } });
    await use(context);
    await context.dispose();
  },
});

export { expect };
