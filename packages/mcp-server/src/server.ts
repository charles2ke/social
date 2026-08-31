import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adapters, decrypt, type PlatformId, type PostDraft } from "@social/core";
import { getAccountForPlatform, getPrismaClient, toPrismaPlatform } from "@social/db";
import { z } from "zod";

const prisma = getPrismaClient();
const platformEnum = z.enum(["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"]);
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function toDraftPayload(post: { id: string; content: string; mediaUrls: unknown; platformOverrides: unknown }) {
  return { id: post.id, text: post.content, mediaUrls: (post.mediaUrls as string[] | null) ?? undefined, perPlatformOverrides: (post.platformOverrides as Record<string, Partial<PostDraft>> | null) ?? undefined };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "social-manager", version: "0.1.0" });
  server.tool("list_platforms", "List platform capabilities.", {}, async () => text(Object.values(adapters).map(({ id, capabilities }) => ({ id, capabilities }))));
  server.tool("list_accounts", "List connected accounts.", {}, async () => {
    const accounts = await prisma.account.findMany({ include: { token: true }, orderBy: { updatedAt: "desc" } });
    return text(accounts.map((account) => ({ id: account.id, platform: account.platform.toLowerCase(), name: account.displayName, tokenExpiresAt: account.token?.expiresAt?.toISOString() })));
  });
  server.tool("get_account_status", "Get a connected account's token status.", { accountId: z.string() }, async ({ accountId }) => {
    const account = await prisma.account.findUnique({ where: { id: accountId }, include: { token: true } });
    if (!account?.token) return text({ accountId, connected: false });
    return text({ accountId, connected: true, platform: account.platform.toLowerCase(), expiresAt: account.token.expiresAt?.toISOString() });
  });
  server.tool("create_draft", "Create a reusable post draft.", { text: z.string().min(1), mediaUrls: z.array(z.string().url()).optional() }, async (draft) => {
    const post = await prisma.post.create({ data: { content: draft.text, mediaUrls: draft.mediaUrls ?? undefined } });
    return text(toDraftPayload(post));
  });
  server.tool("update_draft", "Update a post draft.", { id: z.string(), text: z.string().min(1).optional(), mediaUrls: z.array(z.string().url()).optional() }, async ({ id, ...changes }) => {
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing || existing.status !== "DRAFT") return text({ error: "Draft not found" });
    const post = await prisma.post.update({ where: { id }, data: { content: changes.text ?? undefined, mediaUrls: changes.mediaUrls ?? undefined } });
    return text(toDraftPayload(post));
  });
  server.tool("list_drafts", "List post drafts.", {}, async () => {
    const posts = await prisma.post.findMany({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" } });
    return text(posts.map(toDraftPayload));
  });
  server.tool("publish_post", "Publish now to selected platforms.", { platforms: z.array(platformEnum), text: z.string().min(1), mediaUrls: z.array(z.string().url()).optional(), perPlatformOverrides: z.record(z.object({ text: z.string().optional(), mediaUrls: z.array(z.string().url()).optional() })).optional() }, async ({ platforms, ...draft }) => {
    // Resolve a real, per-account decrypted access token for each target
    // platform (never a single global token) — see
    // docs/adr/0001-database.md and packages/db/src/tokens.ts. MOCK_MODE
    // only falls back to a fake token when no account is connected yet.
    const resolutions = await Promise.all(platforms.map(async (platform) => {
      const account = await getAccountForPlatform(prisma, toPrismaPlatform(platform));
      if (account?.token) return { platform, accountId: account.id, accessToken: decrypt(account.token.encryptedAccessToken) };
      if (process.env.MOCK_MODE === "true") return { platform, accountId: undefined, accessToken: "mock" };
      return { platform, accountId: undefined, accessToken: undefined };
    }));
    const unresolved = resolutions.filter((r) => !r.accessToken).map((r) => r.platform);
    if (unresolved.length) return text({ error: `No connected account token is available for: ${unresolved.join(", ")}` });

    const post = await prisma.post.create({ data: { content: draft.text, mediaUrls: draft.mediaUrls ?? undefined, platformOverrides: draft.perPlatformOverrides ?? undefined, status: "PUBLISHING" } });
    try {
      const results = await Promise.all(resolutions.map(async ({ platform, accountId, accessToken }) => {
        try {
          const result = await adapters[platform as PlatformId].publish({ accessToken: accessToken! }, draft);
          if (accountId) await prisma.platformPublishAttempt.create({ data: { postId: post.id, accountId, platform: toPrismaPlatform(platform), status: "SUCCESS", externalPostId: result.platformPostId, completedAt: result.publishedAt } });
          return { platform, result };
        } catch (error) {
          if (accountId) await prisma.platformPublishAttempt.create({ data: { postId: post.id, accountId, platform: toPrismaPlatform(platform), status: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: new Date() } });
          throw error;
        }
      }));
      await prisma.post.update({ where: { id: post.id }, data: { status: "PUBLISHED" } });
      return text(results);
    } catch (error) {
      await prisma.post.update({ where: { id: post.id }, data: { status: "FAILED" } });
      return text({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.tool("schedule_post", "Schedule a post for a future time.", { platforms: z.array(platformEnum), text: z.string().min(1), scheduledFor: z.string().datetime() }, async ({ platforms, text: body, scheduledFor }) => {
    const post = await prisma.post.create({ data: { content: body, platformOverrides: { platforms }, status: "SCHEDULED", scheduledFor: new Date(scheduledFor) } });
    return text({ id: post.id, scheduledFor });
  });
  server.tool("list_scheduled", "List scheduled posts.", {}, async () => {
    const posts = await prisma.post.findMany({ where: { status: "SCHEDULED" }, orderBy: { scheduledFor: "asc" } });
    return text(posts.map((post) => ({ id: post.id, text: post.content, at: post.scheduledFor?.toISOString(), platforms: (post.platformOverrides as { platforms?: PlatformId[] } | null)?.platforms ?? [] })));
  });
  server.tool("cancel_scheduled", "Cancel a scheduled post.", { id: z.string() }, async ({ id }) => {
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing || existing.status !== "SCHEDULED") return text({ cancelled: false });
    await prisma.post.update({ where: { id }, data: { status: "CANCELLED" } });
    return text({ cancelled: true });
  });
  server.tool("get_post_status", "Get a post status.", { id: z.string() }, async ({ id }) => {
    const post = await prisma.post.findUnique({ where: { id } });
    return text({ id, status: post?.status.toLowerCase() ?? "unknown" });
  });
  server.tool("get_analytics", "Get supported platform metrics.", { platform: platformEnum, postId: z.string() }, async ({ platform, postId }) => text({ platform, postId, available: adapters[platform].capabilities.analytics }));
  server.resource("accounts", "social://accounts", async () => ({ contents: [{ uri: "social://accounts", text: "Connected accounts are available through list_accounts." }] }));
  server.resource("post", new ResourceTemplate("social://posts/{id}", { list: undefined }), async (uri, { id }) => {
    const postId = Array.isArray(id) ? id[0] : id;
    const post = await prisma.post.findUnique({ where: { id: postId } });
    return { contents: [{ uri: uri.href, text: JSON.stringify({ id: postId, draft: post ? toDraftPayload(post) : undefined }) }] };
  });
  server.prompt("cross_platform_announcement", "Draft an announcement for selected social platforms.", { announcement: z.string() }, ({ announcement }) => ({ messages: [{ role: "user", content: { type: "text", text: `Create concise variants of this announcement: ${announcement}` } }] }));
  return server;
}
