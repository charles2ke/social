import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { snap, stubMediaCdn, uniqueText } from "./helpers";
import { apiOrigin } from "./servers";

const repoRoot = path.join(__dirname, "..", "..", "..");
const serverEntry = path.join(repoRoot, "packages", "mcp-server", "dist", "mcp-server", "src", "index.js");

let client: Client;

/** Calls a tool and returns its text blocks, failing the test if the tool reports an error. */
async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content as { text: string }[]).map((item) => item.text);
  expect(result.isError, texts.join("\n")).toBeFalsy();
  return texts;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // Launch the built server over stdio, as Claude Desktop or VS Code would.
  execFileSync("pnpm", ["--filter", "@social/mcp-server", "run", "build"], { cwd: repoRoot, stdio: "inherit" });
  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...getDefaultEnvironment(), SOCIAL_API_URL: apiOrigin, ADMIN_TOKEN: "" },
      stderr: "inherit",
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
});

test("posts drafted, scheduled and published over MCP show up in the dashboard", async ({ page }) => {
  const drafted = uniqueText("Drafted over MCP");
  const linkedinVersion = `${drafted} — with more detail for LinkedIn`;
  const [draft] = await callTool("create_draft", {
    text: drafted,
    platforms: ["linkedin", "facebook"],
    perPlatformOverrides: { linkedin: { text: linkedinVersion } },
  });
  expect(JSON.parse(draft)).toMatchObject({ status: "draft" });

  const scheduled = uniqueText("Scheduled over MCP");
  const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const [queued, warning] = await callTool("schedule_post", { text: scheduled, platforms: ["facebook"], scheduledFor });
  expect(JSON.parse(queued)).toMatchObject({ status: "scheduled" });
  // The e2e API keeps posts in memory, where no worker ever publishes them.
  expect(warning).toContain("never published");

  // Instagram needs media, so a text-only post fails there while LinkedIn succeeds.
  const published = uniqueText("Published over MCP");
  const [firstAttempt, retryHint] = await callTool("publish_post", { text: published, platforms: ["linkedin", "instagram"] });
  const { post } = JSON.parse(firstAttempt);
  expect(post.status).toBe("failed");
  expect(retryHint).toContain(`publish_saved_post (id ${post.id})`);
  const [retry] = await callTool("publish_saved_post", { id: post.id, media: [{ url: "https://cdn.example.com/launch.jpg", kind: "image" }] });
  expect(JSON.parse(retry)).toMatchObject({ post: { status: "published" }, results: [{ platform: "instagram", status: "published" }] });

  await stubMediaCdn(page);
  await page.goto("/posts");
  const draftCard = page.getByRole("article").filter({ hasText: drafted });
  await expect(draftCard.getByRole("listitem")).toHaveText(["LinkedIn (customized)", "Facebook"]);
  await expect(page.getByRole("article").filter({ hasText: scheduled })).toContainText("Scheduled");
  await expect(page.getByRole("article").filter({ hasText: published }).getByRole("listitem")).toHaveText(["LinkedIn published", "Instagram published"]);
  await snap(page, "posts-from-mcp");

  await draftCard.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Post text")).toHaveValue(drafted);
  const linkedin = page.getByRole("list", { name: "Per-platform versions" }).getByRole("listitem", { name: "LinkedIn version" });
  await expect(linkedin.getByLabel("LinkedIn text")).toHaveValue(linkedinVersion);
  await snap(page, "composer-mcp-draft");
});
