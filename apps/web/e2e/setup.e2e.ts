import { expect, test } from "./fixtures";
import { snap } from "./helpers";

test("connects an account through OAuth and disconnects it", async ({ page, api }) => {
  // The e2e API is shared; start from a disconnected LinkedIn.
  for (const account of (await (await api.get("/accounts")).json()) as { id: string; platform: string }[]) {
    if (account.platform === "linkedin") await api.post(`/accounts/${encodeURIComponent(account.id)}/disconnect`);
  }
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/setup");
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "LinkedIn" }) });
  await expect(card).toContainText("Not connected");
  // In mock mode the API's authorization URL is its own callback, which sends the browser back here.
  await card.getByRole("button", { name: "Connect LinkedIn" }).click();

  await expect(page.getByRole("status")).toHaveText("LinkedIn is connected.");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(card).toContainText("Connected as");
  await snap(page, "setup-connected");

  await card.getByRole("button", { name: "Disconnect LinkedIn" }).click();
  await expect(page.getByRole("status")).toHaveText("LinkedIn is disconnected.");
  await expect(card).toContainText("Not connected");
  expect(((await (await api.get("/accounts")).json()) as { platform: string }[]).map(({ platform }) => platform)).not.toContain("linkedin");
});

test("reports a failed connection that the API sends back", async ({ page }) => {
  await page.goto("/setup?platform=linkedin&oauth_error=linkedin%20denied%20the%20authorization%20request");
  await expect(page.getByRole("status")).toHaveText("Connecting LinkedIn failed: linkedin denied the authorization request");
  await expect(page).toHaveURL(/\/setup$/);
});
