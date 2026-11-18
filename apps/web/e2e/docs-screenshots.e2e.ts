import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { apiOrigin, docsScreenshots } from "./servers";
import { stubMediaCdn, toLocalInputValue } from "./helpers";

/**
 * Regenerates the README screenshots in docs/screenshots:
 *   DOCS_SCREENSHOTS=1 pnpm e2e docs-screenshots
 * They show the dashboard as it looks with Postgres configured, so `/ready`
 * is answered as "database up" even though the e2e API keeps posts in memory.
 */
test.skip(!docsScreenshots, "set DOCS_SCREENSHOTS=1 to regenerate docs/screenshots");

const docsDir = path.join(__dirname, "..", "..", "..", "docs", "screenshots");

async function capture(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(docsDir, `${name}.png`), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  await stubMediaCdn(page);
  await page.route(`${apiOrigin}/ready`, (route) => route.fulfill({ json: { ok: true, database: "up" } }));
});

test("composer in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("checkbox", { name: "Instagram" })).toBeChecked();
  await capture(page, "dashboard");
});

test("composing a scheduled post in light mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByLabel("Post text").fill("Launch day! Our self-hosted social manager publishes everywhere at once.");
  await page.getByLabel("Media URL").fill("https://cdn.example.com/launch.jpg");
  await page.getByLabel("Alt text").fill("The Social dashboard on a laptop");
  await page.getByRole("button", { name: "Add media" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByLabel("Schedule for later").check();
  const publishAt = page.getByLabel("Publish at");
  await publishAt.fill(toLocalInputValue(new Date(Date.now() + 7 * 86_400_000)));
  await publishAt.blur();
  await expect(page.getByText("Queued in Postgres")).toBeVisible();
  await capture(page, "compose");
});

test("posts list in light mode", async ({ page, request }) => {
  const call = async (route: string, data?: object) => {
    const response = await request.post(`${apiOrigin}${route}`, data ? { data } : {});
    expect(response.ok(), `${route} answered ${response.status()}`).toBeTruthy();
    return (await response.json()) as { id: string; post?: { id: string } };
  };
  const ids = new Set<string>();
  const draft = async (text: string, platforms: string[], media: object[] = []) => {
    const created = await call("/drafts", { text, platforms, media });
    ids.add(created.id);
    return created.id;
  };

  const image = { url: "https://cdn.example.com/launch.jpg", kind: "image", altText: "The Social dashboard on a laptop" };
  // Created oldest first: the list shows the newest post at the top.
  await call(`/posts/${await draft("Launch day! Our self-hosted social manager publishes everywhere at once.", ["linkedin", "facebook", "instagram"], [image])}/publish`);
  // Instagram needs media, so this one publishes to LinkedIn and fails on Instagram.
  await call(`/posts/${await draft("Changelog: drafts, a publishing queue and one-click retries for failed platforms.", ["linkedin", "instagram"])}/publish`);
  const scheduled = await call("/schedule", {
    text: "Weekly digest — what shipped, what's next, and how to self-host it.",
    platforms: ["linkedin", "facebook"],
    media: [],
    scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
  ids.add(scheduled.id);
  await draft("Idea: a thread on running the scheduler worker next to Postgres.", ["linkedin"]);

  // The e2e API is shared, so the list only shows the posts created above.
  await page.route(`${apiOrigin}/posts`, async (route) => {
    const response = await route.fetch();
    const posts = (await response.json()) as { id: string }[];
    await route.fulfill({ response, json: posts.filter((post) => ids.has(post.id)) });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/posts");
  await expect(page.getByRole("article")).toHaveCount(4);
  await capture(page, "posts");
});

test("setup page", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await capture(page, "setup");
});
