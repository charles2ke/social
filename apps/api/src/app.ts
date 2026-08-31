import Fastify, { type FastifyInstance } from "fastify";
import { adapters, decrypt, type PlatformId } from "@social/core";
import { getAccountForPlatform, getPrismaClient, toPrismaPlatform } from "@social/db";
import { store } from "./store.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const prisma = getPrismaClient();
  app.get("/health", async () => ({ ok: true }));
  app.get("/platforms", async () => Object.values(adapters).map(({ id, capabilities }) => ({ id, capabilities })));
  app.get("/accounts", async () => store.addMockAccounts());
  app.get("/drafts", async () => store.drafts());
  app.post<{ Body: { text: string; mediaUrls?: string[] } }>("/drafts", async (request, reply) => reply.code(201).send(await store.createDraft(request.body)));
  app.post<{ Params: { id: string }; Body: { text?: string; mediaUrls?: string[] } }>("/drafts/:id", async (request, reply) => {
    const draft = await store.updateDraft(request.params.id, request.body);
    return draft ? reply.send(draft) : reply.code(404).send({ error: "Draft not found" });
  });
  app.post<{ Body: { text: string; platforms: PlatformId[]; mediaUrls?: string[] } }>("/publish", async (request, reply) => {
    const { platforms, ...draft } = request.body;
    // Resolve a real, per-account decrypted access token for each target
    // platform (never a single global token) — see
    // docs/adr/0001-database.md and packages/db/src/tokens.ts. MOCK_MODE
    // only falls back to a fake token when no account is connected yet,
    // so local demos work without OAuth apps configured.
    const resolutions = await Promise.all(platforms.map(async (platform) => {
      const account = await getAccountForPlatform(prisma, toPrismaPlatform(platform));
      if (account?.token) return { platform, accountId: account.id, accessToken: decrypt(account.token.encryptedAccessToken) };
      if (process.env.MOCK_MODE === "true") return { platform, accountId: undefined, accessToken: "mock" };
      return { platform, accountId: undefined, accessToken: undefined };
    }));
    const unresolved = resolutions.filter((r) => !r.accessToken).map((r) => r.platform);
    if (unresolved.length) return reply.code(401).send({ error: `No connected account token is available for: ${unresolved.join(", ")}` });

    const post = await prisma.post.create({ data: { content: draft.text, mediaUrls: draft.mediaUrls ?? undefined, status: "PUBLISHING" } });
    try {
      const results = await Promise.all(resolutions.map(async ({ platform, accountId, accessToken }) => {
        const adapter = adapters[platform];
        try {
          const result = await adapter.publish({ accessToken: accessToken! }, draft);
          if (accountId) await prisma.platformPublishAttempt.create({ data: { postId: post.id, accountId, platform: toPrismaPlatform(platform), status: "SUCCESS", externalPostId: result.platformPostId, completedAt: result.publishedAt } });
          return { platform, ...result };
        } catch (error) {
          if (accountId) await prisma.platformPublishAttempt.create({ data: { postId: post.id, accountId, platform: toPrismaPlatform(platform), status: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: new Date() } });
          throw error;
        }
      }));
      await prisma.post.update({ where: { id: post.id }, data: { status: "PUBLISHED" } });
      return results;
    } catch (error) {
      await prisma.post.update({ where: { id: post.id }, data: { status: "FAILED" } });
      throw error;
    }
  });
  return app;
}
