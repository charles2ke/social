import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Every test shares the API's in-memory store, so each post gets text no other test uses. */
export const uniqueText = (label: string) => `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Mirrors the composer's `datetime-local` formatting. */
export function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Saves a full-page screenshot under test-results/screenshots (uploaded by CI) and attaches it to the HTML report. */
export async function snap(page: Page, name: string) {
  const file = path.join(test.info().project.outputDir, "screenshots", `${name}.png`);
  // A full-page capture keeps the scroll offset, which would paint the sticky header mid-page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

/** Replaces the composer's platform selection (it starts with Instagram picked). */
export async function choosePlatforms(page: Page, labels: string[]) {
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  // Scoped to the picker: per-platform versions below it repeat the platform names.
  const picker = page.getByRole("group", { name: "Platforms" });
  for (const label of labels) {
    await picker.locator("label").filter({ hasText: label }).click();
    await expect(picker.getByRole("checkbox", { name: label })).toBeChecked();
  }
}

const thumbnail =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#e1306c"/></linearGradient></defs>' +
  '<rect width="160" height="160" fill="url(#g)"/></svg>';

/** Serves media previews from cdn.example.com locally, so screenshots show a thumbnail rather than a broken image. */
export async function stubMediaCdn(page: Page) {
  await page.route("https://cdn.example.com/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: thumbnail }));
}
