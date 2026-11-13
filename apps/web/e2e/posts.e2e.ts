import { expect, test } from "@playwright/test";
import { choosePlatforms, snap, stubMediaCdn, toLocalInputValue, uniqueText } from "./helpers";

test.beforeEach(async ({ page }) => {
  await stubMediaCdn(page);
  // Publishing and cancelling from the Posts list ask for confirmation first.
  page.on("dialog", (dialog) => void dialog.accept());
});

test("saves a draft, edits it from Posts and publishes it from the list", async ({ page }) => {
  const text = uniqueText("Draft from the e2e suite");
  await page.goto("/");
  await page.getByLabel("Post text").fill(text);
  await choosePlatforms(page, ["LinkedIn"]);
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByRole("status")).toContainText("Draft saved.");
  await expect(page).toHaveURL(/\?post=/);
  await expect(page.getByRole("region", { name: "Editing a saved post" })).toContainText("Editing a saved draft.");

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Posts/ }).click();
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const card = page.getByRole("article").filter({ hasText: text });
  await expect(card).toContainText("Draft");
  await expect(card.getByRole("listitem")).toHaveText(["LinkedIn"]);
  await snap(page, "posts-drafts");

  await card.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Post text")).toHaveValue(text);
  await expect(page.getByRole("checkbox", { name: "LinkedIn" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Instagram" })).not.toBeChecked();
  const edited = `${text} — edited`;
  await page.getByLabel("Post text").fill(edited);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Changes saved.");
  await snap(page, "composer-editing-draft");

  await page.getByRole("link", { name: "View in Posts" }).click();
  const editedCard = page.getByRole("article").filter({ hasText: edited });
  await editedCard.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByRole("status")).toContainText("Published to LinkedIn.");
  await expect(editedCard).toContainText("Published");
  await expect(editedCard.getByRole("listitem")).toHaveText(["LinkedIn published"]);
});

test("records a partial failure and retries only the platform that failed", async ({ page }) => {
  const text = uniqueText("Launch day");
  await page.goto("/");
  await page.getByLabel("Post text").fill(text);
  // Instagram needs media, so in mock mode a text-only post fails there while LinkedIn succeeds.
  await choosePlatforms(page, ["LinkedIn", "Instagram"]);
  await page.getByRole("button", { name: "Publish now" }).click();

  const status = page.getByRole("status");
  await expect(status).toContainText("Some platforms failed");
  await expect(status.getByRole("listitem").filter({ hasText: "LinkedIn" })).toContainText("published");
  await expect(status.getByRole("listitem").filter({ hasText: "Instagram" })).toContainText("failed");
  await expect(page.getByRole("region", { name: "Editing a saved post" })).toContainText("Failed");
  await snap(page, "composer-partial-failure");

  await page.goto("/posts");
  await page.getByRole("button", { name: /^Failed/ }).click();
  const card = page.getByRole("article").filter({ hasText: text });
  await expect(card.getByRole("listitem")).toHaveText(["LinkedIn published", "Instagram failed"]);
  await expect(card).toContainText("instagram:");
  await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
  await snap(page, "posts-failed");

  await card.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Post text")).toHaveValue(text);
  await page.getByLabel("Media URL").fill("https://cdn.example.com/launch.png");
  await page.getByRole("button", { name: "Add media" }).click();
  await page.getByRole("button", { name: "Publish now" }).click();

  await expect(status).toContainText("Published.");
  // LinkedIn already succeeded, so only Instagram was sent again.
  await expect(status.getByRole("listitem")).toHaveCount(1);
  await expect(status.getByRole("listitem")).toContainText("Instagram");
  await expect(page).not.toHaveURL(/\?post=/);

  await page.goto("/posts");
  const published = page.getByRole("article").filter({ hasText: text });
  await expect(published).toContainText("Published");
  await expect(published.getByRole("listitem")).toHaveText(["LinkedIn published", "Instagram published"]);
  await expect(published).toContainText("1 attachment");
  await snap(page, "posts-published");

  await published.getByRole("link", { name: "Copy to new post" }).click();
  await expect(page.getByRole("status")).toContainText("That post is published, so it was copied into a new post.");
  await expect(page.getByLabel("Post text")).toHaveValue(text);
  await expect(page).not.toHaveURL(/\?post=/);
});

test("schedules a post, warns that memory mode never publishes it, and cancels it", async ({ page }) => {
  const text = uniqueText("Weekly digest");
  await page.goto("/");
  await page.getByLabel("Post text").fill(text);
  await choosePlatforms(page, ["LinkedIn", "Facebook"]);
  await page.getByLabel("Schedule for later").check();
  await expect(page.getByText("Posts are only kept in memory.")).toBeVisible();
  await page.getByLabel("Publish at").fill(toLocalInputValue(new Date(Date.now() + 2 * 86_400_000)));
  await page.getByRole("button", { name: "Schedule post" }).click();

  await expect(page.getByRole("status")).toContainText("so it will not be published");
  await expect(page.getByRole("button", { name: "Update schedule" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await snap(page, "composer-scheduled");

  await page.goto("/posts");
  await expect(page.getByText("Posts are only kept in memory.")).toBeVisible();
  await page.getByRole("button", { name: /^Scheduled/ }).click();
  const card = page.getByRole("article").filter({ hasText: text });
  await expect(card).toContainText("Publishes");
  await snap(page, "posts-scheduled");

  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status")).toContainText("Post cancelled.");
  await page.getByRole("button", { name: /^Cancelled/ }).click();
  await expect(card).toContainText("Cancelled");
  await expect(card.getByRole("link", { name: "Copy to new post" })).toBeVisible();
});

test("returns to a blank post when leaving an edit through the Composer link", async ({ page }) => {
  const text = uniqueText("Navigation check");
  await page.goto("/");
  await page.getByLabel("Post text").fill(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\?post=/);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Composer/ }).click();
  await expect(page).not.toHaveURL(/\?post=/);
  await expect(page.getByLabel("Post text")).toHaveValue("");
  await expect(page.getByRole("region", { name: "Editing a saved post" })).toHaveCount(0);
});
