import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { platformIds } from "@social/core";
import { z } from "zod";
import { createApiClient, type ApiClientOptions } from "./api.js";

export type SocialMcpServerOptions = ApiClientOptions;

type Account = { id: string; platform: string };
type PublishResponse = { post: { id: string }; results: { platform: string; status: string }[] };

const postStatuses = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"] as const;

const platform = z.enum(platformIds);
const platforms = z.array(platform);
const media = z
  .array(z.object({ url: z.string().url(), kind: z.enum(["image", "video"]), altText: z.string().optional() }))
  .describe("Image and video attachments, by http(s) URL; each platform fetches them itself. [] means no attachments.");
const mediaUrls = z.array(z.string().url()).describe("Attachment URLs whose kind is inferred from the file extension; an alternative to media.");
const perPlatformOverrides = z
  .record(platform, z.object({ text: z.string().optional(), media: media.optional(), mediaUrls: mediaUrls.optional() }).strict())
  .describe("A platform's own version of the post: its text and/or attachments replace the post's on that platform only. Replaces any existing overrides; {} removes them.");
const scheduledFor = z.string().datetime({ offset: true }).describe("When to publish, as an ISO 8601 date-time such as 2030-01-31T09:00:00Z.");
const postId = z.string().describe("The saved post's id.");

const content = { text: z.string().min(1), media: media.optional(), mediaUrls: mediaUrls.optional(), perPlatformOverrides: perPlatformOverrides.optional() };
const changes = { ...content, text: content.text.optional() };

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const saves: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const overwrites: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const publishes: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const memoryWarning =
  "Warning: the Social API has no DATABASE_URL, so posts are only kept in memory. This post is lost when the API restarts and is never published, because the scheduler worker needs Postgres.";

const json = (value: unknown, ...notes: string[]): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }, ...notes.map((text) => ({ type: "text" as const, text }))],
});
const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
/** Encodes an id as one path segment. fetch resolves "." and ".." away, which would send the request to another route. */
const segment = (id: string) => {
  if (id === "" || id === "." || id === "..") throw new Error(`"${id}" is not a valid id.`);
  return encodeURIComponent(id);
};

/**
 * An MCP server that drives the Social API, so drafts, publishing and the
 * schedule are the same ones the dashboard shows, posts are published as the
 * accounts connected there, and the scheduler worker publishes what is queued.
 */
export function createSocialMcpServer(options: SocialMcpServerOptions): McpServer {
  const api = createApiClient(options);
  const server = new McpServer({ name: "social-manager", version: "0.1.0" });

  /** Reports a failed API call to the model as a tool error instead of a protocol error. */
  const call = async (handler: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await handler();
    } catch (error) {
      return failure(api.scrub(error instanceof Error ? error.message : String(error)));
    }
  };

  /** Scheduling succeeds in memory mode too, but nothing will ever publish the post. */
  const storageWarnings = async (): Promise<string[]> => {
    try {
      const ready = await api.get<{ database?: string }>("/ready");
      return ready?.database === "memory" ? [memoryWarning] : [];
    } catch {
      return [];
    }
  };

  const publishNotes = ({ post, results }: PublishResponse) => {
    const failed = results.filter((result) => result.status === "failed").map((result) => result.platform);
    return failed.length
      ? [`Publishing failed on ${failed.join(", ")}. Fix the problem, then retry with publish_saved_post (id ${post.id}); platforms that already succeeded are skipped.`]
      : [];
  };

  server.registerTool(
    "list_platforms",
    { description: "List every platform with its capabilities, media constraints and text limits.", annotations: readOnly },
    () => call(async () => json(await api.get("/platforms"))),
  );
  server.registerTool(
    "list_accounts",
    { description: "List the connected social accounts. The API publishes to each platform as its connected account.", annotations: readOnly },
    () => call(async () => json(await api.get("/accounts"))),
  );
  server.registerTool(
    "get_account_status",
    {
      description: "Check whether a platform has a connected account to publish as, or look up a connected account by its id.",
      inputSchema: { platform: platform.optional(), accountId: z.string().optional() },
      annotations: readOnly,
    },
    ({ platform, accountId }) =>
      call(async () => {
        if (!platform && !accountId) return failure("Pass a platform or an accountId.");
        const accounts = await api.get<Account[]>("/accounts");
        const account = accounts.find((candidate) => (!accountId || candidate.id === accountId) && (!platform || candidate.platform === platform));
        return json(account ? { connected: true, ...account } : { connected: false, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) });
      }),
  );

  server.registerTool(
    "create_draft",
    {
      description: "Save a draft post. It shows in the dashboard, and its id works with update_draft, publish_saved_post and schedule_saved_post.",
      inputSchema: { ...content, platforms: platforms.optional() },
      annotations: saves,
    },
    (draft) => call(async () => json(await api.post("/drafts", draft))),
  );
  server.registerTool(
    "update_draft",
    {
      description:
        "Edit a saved draft, scheduled or failed post in place; it keeps its status. Only the fields you pass change, and media or perPlatformOverrides replace the stored ones.",
      inputSchema: { id: postId, ...changes, platforms: platforms.optional() },
      annotations: overwrites,
    },
    ({ id, ...update }) => call(async () => json(await api.post(`/drafts/${segment(id)}`, update))),
  );
  server.registerTool(
    "list_drafts",
    { description: "List saved drafts, newest first.", annotations: readOnly },
    () => call(async () => json(await api.get("/drafts"))),
  );
  server.registerTool(
    "list_posts",
    {
      description: "List saved posts, newest first, with each platform's latest result. Pass a status to list only those posts.",
      inputSchema: { status: z.enum(postStatuses).optional() },
      annotations: readOnly,
    },
    ({ status }) => call(async () => json(await api.get(status ? `/posts?status=${status}` : "/posts"))),
  );
  server.registerTool(
    "validate_post",
    {
      description:
        "Check a post against each platform's text and media limits, with each platform's own version applied, without saving or publishing it. Pass platforms to check only those.",
      inputSchema: { ...content, platforms: platforms.optional() },
      annotations: readOnly,
    },
    (draft) => call(async () => json(await api.post("/validate", draft))),
  );

  server.registerTool(
    "publish_post",
    {
      description:
        "Publish new content to the given platforms now. The post is saved first, so it shows in the dashboard with each platform's result and a failed platform can be retried with publish_saved_post.",
      inputSchema: { ...content, platforms: platforms.min(1) },
      annotations: publishes,
    },
    (draft) =>
      call(async () => {
        const saved = await api.post<{ id: string }>("/drafts", draft);
        try {
          const published = await api.post<PublishResponse>(`/posts/${segment(saved.id)}/publish`);
          return json(published, ...publishNotes(published));
        } catch (error) {
          throw new Error(`Saved the post as draft ${saved.id}, but publishing it failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
  );
  server.registerTool(
    "publish_saved_post",
    {
      description:
        "Publish a saved draft, scheduled or failed post now, applying any changes you pass first. Platforms that already succeeded are skipped, so this also retries a partly failed post.",
      inputSchema: { id: postId, ...changes, platforms: platforms.min(1).optional() },
      annotations: publishes,
    },
    ({ id, ...update }) =>
      call(async () => {
        const published = await api.post<PublishResponse>(`/posts/${segment(id)}/publish`, update);
        return json(published, ...publishNotes(published));
      }),
  );

  server.registerTool(
    "schedule_post",
    {
      description:
        "Queue new content for the scheduler worker to publish to the given platforms at scheduledFor. Until the worker picks it up, it can be edited with update_draft or cancelled.",
      inputSchema: { ...content, platforms: platforms.min(1), scheduledFor },
      annotations: saves,
    },
    (post) => call(async () => json(await api.post("/schedule", post), ...(await storageWarnings()))),
  );
  server.registerTool(
    "schedule_saved_post",
    {
      description:
        "Queue a saved draft or failed post for the scheduler worker to publish at scheduledFor, or move a scheduled post to a new time, applying any changes you pass first. A failed post gets a fresh set of attempts.",
      inputSchema: { id: postId, ...changes, platforms: platforms.min(1), scheduledFor },
      annotations: saves,
    },
    (post) => call(async () => json(await api.post("/schedule", post), ...(await storageWarnings()))),
  );
  server.registerTool(
    "list_scheduled",
    { description: "List the posts queued for the scheduler worker, with their scheduledFor times.", annotations: readOnly },
    () => call(async () => json(await api.get("/posts?status=scheduled"))),
  );
  server.registerTool(
    "cancel_scheduled",
    {
      description: "Cancel a scheduled, draft or failed post so it is never published. This fails once publishing has started.",
      inputSchema: { id: postId },
      annotations: overwrites,
    },
    ({ id }) => call(async () => json(await api.post(`/posts/${segment(id)}/cancel`))),
  );
  server.registerTool(
    "get_post_status",
    {
      description: "Get a saved post with its status and each platform's latest attempt, including the platform's own post id once published.",
      inputSchema: { id: postId },
      annotations: readOnly,
    },
    ({ id }) => call(async () => json(await api.get(`/posts/${segment(id)}`))),
  );
  server.registerTool(
    "get_analytics",
    {
      description: "Get a published post's metrics from a platform. postId is the platform's own post id: platformPostId in a publish result, or externalPostId in a post's attempts.",
      inputSchema: { platform, postId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ platform, postId }) => call(async () => json(await api.get(`/analytics/${platform}/${segment(postId)}`))),
  );

  server.registerResource(
    "accounts",
    "social://accounts",
    { description: "The connected social accounts.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await api.get("/accounts"), null, 2) }] }),
  );
  server.registerResource(
    "post",
    new ResourceTemplate("social://posts/{id}", { list: undefined }),
    { description: "A saved post with its status and each platform's latest attempt.", mimeType: "application/json" },
    async (uri, { id }) => {
      const post = await api.get(`/posts/${segment(Array.isArray(id) ? id[0] : id)}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(post, null, 2) }] };
    },
  );

  server.registerPrompt(
    "cross_platform_announcement",
    { description: "Draft an announcement as a version per platform, within each platform's limits.", argsSchema: { announcement: z.string() } },
    ({ announcement }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Write a concise version of this announcement for each platform I want to post it to (ask me which if I haven't said). " +
              "Check each platform's text limits and media rules with list_platforms, save the post with create_draft, putting each platform's own version in perPlatformOverrides, " +
              `and check it with validate_post before publishing or scheduling it.\n\nAnnouncement: ${announcement}`,
          },
        },
      ],
    }),
  );

  return server;
}
