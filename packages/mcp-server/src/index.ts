#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { adapters, platformIds, type PlatformId, type PostDraft } from "@social/core";
import { z } from "zod";

const mediaSchema = z.array(z.object({ url: z.string().url(), kind: z.enum(["image", "video"]), altText: z.string().optional() })).optional().describe("Image/video attachments to publish with the post.");
const platformSchema = z.enum(platformIds);
const drafts = new Map<string, PostDraft>(); const scheduled = new Map<string, { draft: PostDraft; at: string; platforms: PlatformId[] }>();
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const server = new McpServer({ name: "social-manager", version: "0.1.0" });
server.tool("list_platforms", "List platform capabilities, including image/video limits.", {}, async () => text(Object.values(adapters).map(({ id, capabilities, mediaConstraints }) => ({ id, capabilities, mediaConstraints }))));
server.tool("list_accounts", "List connected accounts.", {}, async () => text([]));
server.tool("get_account_status", "Get a connected account's token status.", { accountId: z.string() }, async ({ accountId }) => text({ accountId, connected: false }));
server.tool("create_draft", "Create a reusable post draft.", { text: z.string().min(1), mediaUrls: z.array(z.string().url()).optional(), media: mediaSchema }, async (draft) => { const id = randomUUID(); drafts.set(id, draft); return text({ id, ...draft }); });
server.tool("update_draft", "Update a post draft.", { id: z.string(), text: z.string().min(1).optional(), mediaUrls: z.array(z.string().url()).optional(), media: mediaSchema }, async ({ id, ...changes }) => { const draft = drafts.get(id); if (!draft) return text({ error: "Draft not found" }); const updated = { ...draft, ...changes }; drafts.set(id, updated); return text({ id, ...updated }); });
server.tool("list_drafts", "List post drafts.", {}, async () => text([...drafts.entries()].map(([id, draft]) => ({ id, ...draft }))));
server.tool("publish_post", "Publish now to selected platforms.", { platforms: z.array(platformSchema), text: z.string().min(1), mediaUrls: z.array(z.string().url()).optional(), media: mediaSchema, perPlatformOverrides: z.record(z.object({ text: z.string().optional(), mediaUrls: z.array(z.string().url()).optional(), media: mediaSchema })).optional() }, async ({ platforms, ...draft }) => {
  const accessToken = process.env.MOCK_MODE === "true" ? "mock" : process.env.SOCIAL_ACCESS_TOKEN;
  if (!accessToken) return text({ error: "No connected account token is available" });
  return text(await Promise.all(platforms.map(async (platform) => {
    try { return { platform, result: await adapters[platform].publish({ accessToken }, draft) }; }
    catch (error) { return { platform, error: error instanceof Error ? error.message : "Publishing failed" }; }
  })));
});
server.tool("schedule_post", "Schedule a post for a future time.", { platforms: z.array(platformSchema), text: z.string().min(1), media: mediaSchema, scheduledFor: z.string().datetime() }, async ({ platforms, text: body, media, scheduledFor }) => { const id = randomUUID(); scheduled.set(id, { draft: { text: body, media }, platforms, at: scheduledFor }); return text({ id, scheduledFor }); });
server.tool("list_scheduled", "List scheduled posts.", {}, async () => text([...scheduled.entries()].map(([id, value]) => ({ id, ...value }))));
server.tool("cancel_scheduled", "Cancel a scheduled post.", { id: z.string() }, async ({ id }) => text({ cancelled: scheduled.delete(id) }));
server.tool("get_post_status", "Get a post status.", { id: z.string() }, async ({ id }) => text({ id, status: "unknown" }));
server.tool("get_analytics", "Get supported platform metrics.", { platform: platformSchema, postId: z.string() }, async ({ platform, postId }) => text({ platform, postId, available: adapters[platform].capabilities.analytics }));
server.resource("accounts", "social://accounts", async () => ({ contents: [{ uri: "social://accounts", text: "Connected accounts are available through list_accounts." }] }));
server.resource("post", new ResourceTemplate("social://posts/{id}", { list: undefined }), async (uri, { id }) => { const postId = Array.isArray(id) ? id[0] : id; return { contents: [{ uri: uri.href, text: JSON.stringify({ id: postId, draft: drafts.get(postId) }) }] }; });
server.prompt("cross_platform_announcement", "Draft an announcement for selected social platforms.", { announcement: z.string() }, ({ announcement }) => ({ messages: [{ role: "user", content: { type: "text", text: `Create concise variants of this announcement: ${announcement}` } }] }));
await server.connect(new StdioServerTransport());
