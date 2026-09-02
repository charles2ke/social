import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConfigurationError,
  PlatformApiError,
  UnsupportedOperation,
  adapters,
  platformIds,
  redactSecrets,
  type PlatformId,
  type TokenSet,
} from "@social/core";
import { authorizedToken, createAccountRepository } from "./accounts.js";
import { createState, verifyState } from "./oauth-state.js";
import { createRateLimiter } from "./rate-limit.js";
import { store } from "./store.js";

const mockMode = process.env.MOCK_MODE === "true";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken && !mockMode) {
  throw new Error("ADMIN_TOKEN must be set outside mock mode — the API exposes account and publishing endpoints");
}

const repository = await createAccountRepository();
const app = Fastify({ logger: false });
const isPlatform = (value: string): value is PlatformId => (platformIds as readonly string[]).includes(value);

/** OAuth callbacks are authenticated by their signed `state`, not by the admin token. */
const isCallback = (url: string) => /^\/api\/oauth\/[^/]+\/callback(\?|$)/.test(url);
const isPublicRoute = (url: string) => url === "/health" || isCallback(url);
const allowCallback = createRateLimiter(Number(process.env.OAUTH_CALLBACK_RATE_LIMIT ?? 20), 60_000);

app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
  if (isCallback(request.url) && !allowCallback(request.ip)) {
    return reply.code(429).send({ error: "Too many OAuth callback requests" });
  }
  if (isPublicRoute(request.url) || !adminToken) return;
  const header = request.headers.authorization ?? "";
  const scheme = "Bearer ";
  const presented = Buffer.from(header.startsWith(scheme) ? header.slice(scheme.length) : header, "utf8");
  const expected = Buffer.from(adminToken, "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof UnsupportedOperation) return reply.code(501).send({ error: error.message });
  if (error instanceof ConfigurationError) return reply.code(400).send({ error: error.message });
  if (error instanceof PlatformApiError) return reply.code(502).send({ error: error.message });
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.code(status).send({ error: redactSecrets(error.message || "Request failed") });
});

app.get("/health", async () => ({ ok: true }));
app.get("/platforms", async () => Object.values(adapters).map(({ id, capabilities }) => ({ id, capabilities })));
app.get("/accounts", async () => repository.list());
app.get("/drafts", async () => store.drafts());
app.post<{ Body: { text: string; mediaUrls?: string[] } }>("/drafts", async (request, reply) => reply.code(201).send(store.createDraft(request.body)));
app.post<{ Params: { id: string }; Body: { text?: string; mediaUrls?: string[] } }>("/drafts/:id", async (request, reply) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.id)) return reply.code(400).send({ error: "Invalid draft id" });
  const draft = store.updateDraft(request.params.id, request.body);
  return draft ? reply.send(draft) : reply.code(404).send({ error: "Draft not found" });
});

app.get<{ Params: { platform: string } }>("/api/oauth/:platform/start", async (request, reply) => {
  const { platform } = request.params;
  if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
  return reply.redirect(adapters[platform].getAuthUrl(createState(platform)), 302);
});

app.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
  "/api/oauth/:platform/callback",
  async (request, reply) => {
    const { platform } = request.params;
    const { code, state, error } = request.query;
    if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
    if (error) return reply.code(400).send({ error: `${platform} denied the authorization request` });
    if (!code || !state || !verifyState(state, platform)) return reply.code(400).send({ error: "Invalid or expired OAuth state" });

    const adapter = adapters[platform];
    const token = await adapter.exchangeCode(code);
    const profile = await adapter.getProfile(token);
    const account = await repository.connect(platform, profile, token);
    await repository.writeToken(account.id, { ...token, externalId: token.externalId ?? profile.id });
    const base = process.env.BASE_URL;
    return base ? reply.redirect(`${base.replace(/\/$/, "")}/?connected=${platform}`, 302) : reply.send(account);
  },
);

/** Resolves the token to publish with, falling back to a mock token in mock mode. */
async function tokenFor(platform: PlatformId): Promise<TokenSet> {
  const account = await repository.findByPlatform(platform);
  if (account) return authorizedToken(repository, account, (token) => adapters[platform].refreshToken(token));
  if (mockMode) return { accessToken: "mock", externalId: `mock-${platform}` };
  throw new ConfigurationError(platform, `a connected account — visit /api/oauth/${platform}/start`);
}

app.post<{ Body: { text: string; platforms: PlatformId[]; mediaUrls?: string[] } }>("/publish", async (request, reply) => {
  const { platforms, ...draft } = request.body;
  if (!Array.isArray(platforms) || !platforms.length) return reply.code(400).send({ error: "At least one platform is required" });
  const unknown = platforms.filter((platform) => !isPlatform(platform));
  if (unknown.length) return reply.code(400).send({ error: `Unknown platform(s): ${unknown.join(", ")}` });

  return Promise.all(
    platforms.map(async (platform) => {
      try {
        const result = await adapters[platform].publish(await tokenFor(platform), draft);
        return { platform, status: "published" as const, ...result };
      } catch (error) {
        return { platform, status: "failed" as const, error: redactSecrets(error instanceof Error ? error.message : "Publishing failed") };
      }
    }),
  );
});

app.get<{ Params: { platform: string; postId: string } }>("/analytics/:platform/:postId", async (request, reply) => {
  const { platform, postId } = request.params;
  if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
  return adapters[platform].getAnalytics(await tokenFor(platform), { platformPostId: postId });
});

app.listen({ port: Number(process.env.API_PORT ?? 3001), host: "0.0.0.0" }).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
