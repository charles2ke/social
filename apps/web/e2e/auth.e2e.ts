import { expect, sessionKey, test } from "./fixtures";
import { snap, uniqueText } from "./helpers";
import { adminToken, apiOrigin } from "./servers";

test.use({ signedIn: false });

test("signs in with the admin token, keeps only a session in the browser, and signs out", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Post text")).toHaveCount(0);

  await page.getByLabel("Admin token").fill("not-the-admin-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("That admin token is not right.");
  await snap(page, "sign-in");

  await page.getByLabel("Admin token").fill(adminToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Post text")).toBeVisible();
  const stored = await page.evaluate(() =>
    [sessionStorage, localStorage].flatMap((storage) => Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`)).join("\n"),
  );
  expect(stored).toContain(`${sessionKey}=`);
  expect(stored).not.toContain(adminToken);

  // The session lasts for the tab, across reloads.
  await page.reload();
  await expect(page.getByLabel("Post text")).toBeVisible();

  const { token } = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "{}") as { token: string }, sessionKey);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Post text")).toHaveCount(0);
  // Signing out revokes the session on the API, not just in this tab.
  expect((await request.get(`${apiOrigin}/posts`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test("asks to sign in again when the session ends, without losing unsaved work", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Admin token").fill(adminToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  const text = uniqueText("Written before the session ended");
  await page.getByLabel("Post text").fill(text);

  // End the session from outside the page, as a sign-out in another tab or an expiry would.
  const { token } = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "{}") as { token: string }, sessionKey);
  expect((await request.post(`${apiOrigin}/auth/logout`, { headers: { Authorization: `Bearer ${token}` } })).ok()).toBeTruthy();

  await page.getByRole("button", { name: "Save draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in again" });
  await expect(dialog).toBeVisible();
  await snap(page, "sign-in-again");

  await dialog.getByLabel("Admin token").fill(adminToken);
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Post text")).toHaveValue(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved.");
});
