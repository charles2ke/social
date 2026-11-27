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

test("signs out locally even when logout never responds", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Admin token").fill(adminToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Post text")).toBeVisible();

  let releaseLogout = () => {};
  const pendingLogout = new Promise<void>((resolve) => { releaseLogout = resolve; });
  let logoutStarted = () => {};
  const logoutRequest = new Promise<void>((resolve) => { logoutStarted = resolve; });
  await page.route(`${apiOrigin}/auth/logout`, async (route) => {
    logoutStarted();
    await pendingLogout;
    await route.fulfill({ status: 204 });
  });

  try {
    await page.getByRole("button", { name: "Sign out" }).click();
    await logoutRequest;
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByLabel("Post text")).toHaveCount(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();

    await page.getByLabel("Admin token").fill(adminToken);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Post text")).toBeVisible();
    releaseLogout();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.getByLabel("Post text")).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).not.toBeNull();
  } finally {
    releaseLogout();
  }
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
  await expect(dialog).toHaveJSProperty("open", true);
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(dialog.getByLabel("Admin token")).toBeFocused();
  await snap(page, "sign-in-again");
  await page.locator("header a").first().evaluate((element: HTMLElement) => element.focus());
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const postsLink = await page.locator('aside a[href="/posts"]').boundingBox();
  expect(postsLink).not.toBeNull();
  await page.mouse.click(postsLink!.x + postsLink!.width / 2, postsLink!.y + postsLink!.height / 2);
  await expect(page).toHaveURL("/");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Admin token").fill("wrong-token");
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate((element) => document.activeElement === document.body || element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That admin token is not right.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Admin token").fill(adminToken);
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Post text")).toHaveValue(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved.");
});
