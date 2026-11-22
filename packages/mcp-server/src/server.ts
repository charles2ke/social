import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { platformIds, redactSecrets } from "@social/core";
import { z } from "zod";
import { ApiError, type ApiClient } from "./client.js";

const platform = z.enum(platformIds);
const platforms = z.array(platform).min(1).describe("Platforms to post to.");
/** Same shape the API accepts; it also keeps an id from changing the request path (e.g. `..`). */
const postIdPattern = /^[0-9a-z-]{8,64}$/i;
const postId = z.string().regex(postIdPattern, "Invalid post id").describe("Post id returned by create_draft, schedule_post or a list tool.");
const media = z
  .array(z.object({ url: z.string().url(), kind: z.enum(["image", "video"]), altText: z.string().max(1000).optional() }))
  .max(20)
  .optional()
  .describe("Image/video attachments, as public http(s) URLs.");
const mediaUrls = z.array(z.string().url()).max(20).optional().describe("Shorthand for media: URLs whose kind is inferred from the file extension.");
const platformOverrides = z
  .partialRecord(platform, z.object({ text: z.string() }))
  .optional()
  .describe("Text that replaces `text` on individual platforms, e.g. a shorter variant where the character limit is lower (see list_platforms). An empty object removes all overrides.");

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs an API call for a tool, turning failures into an error result the model can read and act on. */
async function call(request: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await request());
  } catch (error) {
    const message = error instanceof ApiError ? `Social API error (HTTP ${error.status}): ${error.message}` : error instanceof Error ? error.message : "Request failed";
    return { content: [{ type: "text", text: redactSecrets(message) }], isError: true };
  }
}

type Account = { id: string; platform: string; name?: string; tokenExpiresAt?: string };

/** The MCP server, backed by the Social API (see createApiClient). */
export function createServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: "social-manager", version: "0.2.0" });
  const post = (path: string, body: unknown = {}) => api.request("POST", path, body);
  const get = (path: string) => api.request("GET", path);
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_platforms", { description: "List each platform's capabilities and its media and text limits.", annotations: readOnly }, () => call(() => get("platforms")));
  server.registerTool("list_accounts", { description: "List the connected platform accounts.", annotations: readOnly }, () => call(() => get("accounts")));
  server.registerTool(
    "get_account_status",
    { description: "Whether an account is connected, and when its token expires.", inputSchema: { accountId: z.string().min(1).max(256) }, annotations: readOnly },
    ({ accountId }) =>
      call(async () => {
        const account = ((await get("accounts")) as Account[]).find((candidate) => candidate.id === accountId);
        return account ? { accountId, connected: true, platform: account.platform, name: account.name, tokenExpiresAt: account.tokenExpiresAt } : { accountId, connected: false };
      }),
  );

  server.registerTool(
    "create_draft",
    { description: "Save a post as a draft without publishing it.", inputSchema: { text: z.string().min(1), platforms: z.array(platform).optional(), media, mediaUrls, platformOverrides } },
    (draft) => call(() => post("drafts", draft)),
  );
  server.registerTool(
    "update_draft",
    {
      description: "Change a draft, scheduled or failed post. Fields left out keep their saved values.",
      inputSchema: { id: postId, text: z.string().min(1).optional(), platforms: z.array(platform).optional(), media, mediaUrls, platformOverrides },
    },
    ({ id, ...changes }) => call(() => post(`drafts/${encodeURIComponent(id)}`, changes)),
  );
  server.registerTool("list_drafts", { description: "List saved drafts, newest first.", annotations: readOnly }, () => call(() => get("drafts")));

  server.registerTool(
    "publish_post",
    {
      description: "Publish a post to the given platforms right away, without saving it. Returns a per-platform result.",
      inputSchema: { platforms, text: z.string().min(1), media, mediaUrls, platformOverrides },
      annotations: { openWorldHint: true },
    },
    (draft) => call(() => post("publish", draft)),
  );
  server.registerTool(
    "publish_draft",
    {
      description: "Publish a saved draft, scheduled or failed post right away. Platforms that already succeeded are skipped, so this also retries a partially failed post.",
      inputSchema: { id: postId, platforms: platforms.optional() },
      annotations: { openWorldHint: true },
    },
    ({ id, ...changes }) => call(() => post(`posts/${encodeURIComponent(id)}/publish`, changes)),
  );
  server.registerTool(
    "schedule_post",
    {
      description: "Schedule a new post, or a saved draft (pass its id), for publishing at a future time.",
      inputSchema: {
        platforms,
        scheduledFor: z.string().datetime({ offset: true }).describe("ISO 8601 date-time, e.g. 2030-01-31T09:00:00Z."),
        id: postId.optional().describe("Schedule this saved draft instead of creating a new post."),
        text: z.string().min(1).optional().describe("Required unless id is given."),
        media,
        mediaUrls,
        platformOverrides,
      },
    },
    (input) => call(() => post("schedule", input)),
  );
  server.registerTool("list_scheduled", { description: "List posts waiting to be published.", annotations: readOnly }, () => call(() => get("posts?status=scheduled")));
  server.registerTool(
    "cancel_scheduled",
    { description: "Cancel a draft or scheduled post. Not possible once publishing has started.", inputSchema: { id: postId }, annotations: { destructiveHint: true, openWorldHint: false } },
    ({ id }) => call(() => post(`posts/${encodeURIComponent(id)}/cancel`)),
  );
  server.registerTool(
    "get_post_status",
    { description: "Get a post's status and per-platform publish results.", inputSchema: { id: postId }, annotations: readOnly },
    ({ id }) => call(() => get(`posts/${encodeURIComponent(id)}`)),
  );
  server.registerTool(
    "get_analytics",
    {
      description: "Get metrics for a published post on platforms that support analytics.",
      inputSchema: { platform, postId: z.string().regex(/^[\w:-][\w:.-]{0,199}$/, "Invalid platform post id").describe("The platform's post id from a publish result.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ platform: id, postId: platformPostId }) => call(() => get(`analytics/${id}/${encodeURIComponent(platformPostId)}`)),
  );

  server.registerResource("accounts", "social://accounts", { description: "Connected accounts", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await get("accounts"), null, 2) }],
  }));
  server.registerResource("post", new ResourceTemplate("social://posts/{id}", { list: undefined }), { description: "A post and its publish status", mimeType: "application/json" }, async (uri, { id }) => {
    const value = Array.isArray(id) ? id[0] : id;
    if (!value || !postIdPattern.test(value)) throw new Error("Invalid post id");
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await get(`posts/${encodeURIComponent(value)}`), null, 2) }] };
  });

  server.registerPrompt(
    "cross_platform_announcement",
    { description: "Draft an announcement with a variant per platform.", argsSchema: { announcement: z.string() } },
    ({ announcement }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Create concise variants of this announcement for each platform I want to post to. Check each platform's character limits with list_platforms, keep every variant within them, and pass the variants as platformOverrides when you create the draft:\n\n${announcement}`,
          },
        },
      ],
    }),
  );
  return server;
}
