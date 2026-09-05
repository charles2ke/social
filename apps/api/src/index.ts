import { timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConfigurationError,
  MediaValidationError,
  PlatformApiError,
  UnsupportedOperation,
  adapters,
  normalizeMedia,
  platformIds,
  redactSecrets,
  validateMedia,
  type MediaAttachment,
  type PlatformId,
  type TokenSet,
} from "@social/core";
import { authorizedToken, createAccountRepository } from "./accounts.js";
import { createState, verifyState } from "./oauth-state.js";
import { store } from "./store.js";

const mockMode = process.env.MOCK_MODE === "true";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken && !mockMode) {
  throw new Error("ADMIN_TOKEN must be set outside mock mode — the API exposes account and publishing endpoints");
}

const repository = await createAccountRepository();
const app = Fastify({ logger: false, bodyLimit: Number(process.env.API_BODY_LIMIT ?? 1_048_576) });
const isPlatform = (value: string): value is PlatformId => (platformIds as readonly string[]).includes(value);

type DraftBody = { text: string; mediaUrls?: string[]; media?: MediaAttachment[] };

/** Merge `media`/`mediaUrls` into typed attachments, returning the validation error instead of throwing. */
function resolveMedia(body: Partial<DraftBody>): MediaAttachment[] | Error {
  try { return normalizeMedia(body); } catch (error) { return error instanceof MediaValidationError ? error : new Error("Invalid media"); }
}

/** OAuth callbacks are authenticated by their signed `state`, not by the admin token. */
const isCallback = (url: string) => /^\/api\/oauth\/[^/]+\/callback(\?|$)/.test(url);
const isPublicRoute = (url: string) => url === "/health" || isCallback(url);
/**
 * The OAuth callback is the only unauthenticated write path, so it is limited
 * more tightly than the admin-authenticated routes.
 */
const callbackRateLimit = { max: Number(process.env.OAUTH_CALLBACK_RATE_LIMIT ?? 20), timeWindow: "1 minute" };
await app.register(rateLimit, { max: Number(process.env.API_RATE_LIMIT ?? 300), timeWindow: "1 minute" });

app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
  if (isPublicRoute(request.url) || !adminToken) return;
  const header = request.headers.authorization ?? "";
  const scheme = "Bearer ";
  const presented = Buffer.from(header.startsWith(scheme) ? header.slice(scheme.length) : header, "utf8");
  const expected = Buffer.from(adminToken, "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// Every route replies with JSON only; nosniff keeps a browser from rendering echoed draft text as HTML.
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  if (!reply.hasHeader("location")) reply.type("application/json");
});

app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (error instanceof MediaValidationError) return reply.code(400).send({ error: error.message });
  if (error instanceof UnsupportedOperation) return reply.code(501).send({ error: error.message });
  if (error instanceof ConfigurationError) return reply.code(400).send({ error: error.message });
  if (error instanceof PlatformApiError) return reply.code(502).send({ error: error.message });
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.code(status).send({ error: redactSecrets(error.message || "Request failed") });
});

app.get("/health", async () => ({ ok: true }));
app.get("/platforms", async () => Object.values(adapters).map(({ id, capabilities, mediaConstraints }) => ({ id, capabilities, mediaConstraints })));
app.get("/accounts", async () => repository.list());
app.get("/drafts", async () => store.drafts());
app.post<{ Body: DraftBody }>("/drafts", async (request, reply) => {
  const media = resolveMedia(request.body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  return reply.code(201).type("application/json").send(store.createDraft({ ...request.body, media }));
});
app.post<{ Params: { id: string }; Body: Partial<DraftBody> }>("/drafts/:id", async (request, reply) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.id)) return reply.code(400).send({ error: "Invalid draft id" });
  // Only touch stored media when the update actually carries media fields, so a text-only update keeps existing attachments.
  const hasMedia = request.body.media !== undefined || request.body.mediaUrls !== undefined;
  const media = hasMedia ? resolveMedia(request.body) : undefined;
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  const draft = store.updateDraft(request.params.id, media ? { ...request.body, media } : request.body);
  return draft ? reply.type("application/json").send(draft) : reply.code(404).send({ error: "Draft not found" });
});

app.get<{ Params: { platform: string } }>("/api/oauth/:platform/start", async (request, reply) => {
  const { platform } = request.params;
  if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
  return reply.redirect(adapters[platform].getAuthUrl(createState(platform)), 302);
});

app.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
  "/api/oauth/:platform/callback",
  { config: { rateLimit: callbackRateLimit } },
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

app.post<{ Body: DraftBody & { platforms: PlatformId[] } }>("/publish", async (request, reply) => {
  const { platforms, ...body } = request.body;
  if (!Array.isArray(platforms) || !platforms.length) return reply.code(400).send({ error: "At least one platform is required" });
  const unknown = platforms.filter((platform) => !isPlatform(platform));
  if (unknown.length) return reply.code(400).send({ error: `Unknown platform(s): ${unknown.join(", ")}` });
  const media = resolveMedia(body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  const draft = { ...body, media };

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

/** Media compatibility for a draft, per platform — lets clients warn before publishing. */
app.post<{ Body: DraftBody }>("/media/validate", async (request, reply) => {
  const media = resolveMedia(request.body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  return Object.values(adapters).map((adapter) => {
    try { validateMedia(adapter.id, adapter.capabilities, adapter.mediaConstraints, media); return { platform: adapter.id, compatible: true }; }
    catch (error) { return { platform: adapter.id, compatible: false, reason: error instanceof Error ? error.message : "Incompatible media" }; }
  });
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
