import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConfigurationError,
  MediaValidationError,
  PlatformApiError,
  TextValidationError,
  UnsupportedOperation,
  adapters,
  normalizeMedia,
  platformIds,
  redactSecrets,
  textProblems,
  validateMedia,
  type MediaAttachment,
  type PlatformId,
  type PlatformOverrides,
  type PostDraft,
} from "@social/core";
import type { AccountRepository } from "./accounts.js";
import { createSessions, presentedCredential, secretsMatch } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { createOAuthStates } from "./oauth-state.js";
import { hasOverrides, parsePlatformOverrides } from "./overrides.js";
import { isEditable, type PostInput, type PostPublisher, type PostRepository, type PostStatus } from "./posts.js";
import type { Publisher } from "./publisher.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Reachable without the admin token or a session. */
    public?: boolean;
  }
}

export type AppDeps = {
  config: ApiConfig;
  accounts: AccountRepository;
  posts: PostRepository;
  publisher: Publisher;
  /** Readiness check for the database; omitted when the API runs on in-memory storage. */
  checkDatabase?: () => Promise<void>;
};

type Body = Record<string, unknown>;

const isPlatform = (value: unknown): value is PlatformId => typeof value === "string" && (platformIds as readonly string[]).includes(value);
const postStatuses = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"] as const;
const isPostStatus = (value: string): value is PostStatus => (postStatuses as readonly string[]).includes(value);
/** Accepts both the in-memory repository's UUIDs and Postgres' cuids. */
const isPostId = (value: string) => /^[0-9a-z-]{8,64}$/i.test(value);
/** Platform post ids (numeric ids, `page_post` ids, LinkedIn URNs, YouTube ids) — never a path. */
const isPlatformPostId = (value: string) => /^[\w:-][\w:.-]{0,199}$/.test(value);
/** Request bodies are untrusted JSON: anything but an object (null, an array, a string) counts as empty. */
const asBody = (value: unknown): Body => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : {});

/**
 * Returns the error message for an invalid `platforms` array, or undefined
 * when it is valid. Drafts may be saved before any platform is picked.
 */
function validatePlatforms(platforms: unknown, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (!Array.isArray(platforms)) return options.allowEmpty ? "platforms must be an array" : "At least one platform is required";
  if (!platforms.length && !options.allowEmpty) return "At least one platform is required";
  const unknown = platforms.filter((platform) => !isPlatform(platform));
  if (unknown.length) return `Unknown platform(s): ${unknown.map(String).join(", ").slice(0, 200)}`;
  const duplicates = platforms.filter((platform, index) => platforms.indexOf(platform) !== index);
  return duplicates.length ? `Duplicate platform(s): ${[...new Set(duplicates)].join(", ")}` : undefined;
}

/** Merge `media`/`mediaUrls` into typed attachments, returning the validation error instead of throwing. */
function resolveMedia(body: Body): MediaAttachment[] | Error {
  try {
    return normalizeMedia(body as Pick<PostDraft, "media" | "mediaUrls">);
  } catch (error) {
    return error instanceof MediaValidationError ? error : new Error("Invalid media");
  }
}

/**
 * Validates the optional content changes carried by an update or publish
 * request. Fields left out keep their stored values, so a text-only change
 * keeps the stored attachments and overrides.
 */
function resolveChanges(body: Body, options: { allowNoPlatforms: boolean }): Partial<PostInput> | Error {
  const hasMedia = body.media !== undefined || body.mediaUrls !== undefined;
  const media = hasMedia ? resolveMedia(body) : undefined;
  if (media instanceof Error) return media;
  if (body.text !== undefined && typeof body.text !== "string") return new Error("text must be a string");
  const platformError = body.platforms === undefined ? undefined : validatePlatforms(body.platforms, { allowEmpty: options.allowNoPlatforms });
  if (platformError) return new Error(platformError);
  const platformOverrides = body.platformOverrides === undefined ? undefined : parsePlatformOverrides(body.platformOverrides);
  if (platformOverrides instanceof Error) return platformOverrides;
  return {
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    ...(media ? { media } : {}),
    ...(body.platforms !== undefined ? { platforms: body.platforms as PlatformId[] } : {}),
    ...(platformOverrides ? { platformOverrides } : {}),
  };
}

/** Every text limit the post breaks on the platforms it targets (each platform's override, or the main text). */
function textLimitError(platforms: readonly PlatformId[], text: string, overrides: PlatformOverrides = {}): string | undefined {
  const problems = platforms.flatMap((platform) => textProblems(platform, adapters[platform].textConstraints, overrides[platform]?.text ?? text));
  return problems.length ? problems.join("; ") : undefined;
}

/** Errors with a message meant for the user, and the status they map to. */
function knownErrorStatus(error: unknown): number | undefined {
  if (error instanceof MediaValidationError || error instanceof TextValidationError || error instanceof ConfigurationError) return 400;
  if (error instanceof UnsupportedOperation) return 501;
  if (error instanceof PlatformApiError) return 502;
  return undefined;
}

function logError(request: FastifyRequest, error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // The route pattern, never the URL: query strings (OAuth codes) stay out of logs.
  console.error(JSON.stringify({ level: "error", msg: "request failed", requestId: request.id, method: request.method, route: request.routeOptions.url, error: redactSecrets(message) }));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, accounts, posts, publisher } = deps;
  const { adminToken } = config;
  const sessions = adminToken ? createSessions(adminToken, config.sessionTtlMs) : undefined;
  const states = createOAuthStates(config.oauthStateSecret);
  const postPublisher: PostPublisher = {
    publish: publisher.publish,
    accountIdFor: async (platform) => (await publisher.accountFor(platform))?.id,
  };
  // A hop count trusts that many proxies in front of the API (the typings omit the numeric form, so it is spelled out).
  const hops = config.trustProxy;
  const trustProxy = typeof hops === "number" ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({ logger: false, bodyLimit: config.bodyLimit, trustProxy });

  /** The admin token, or a dashboard session minted from it. */
  const isAuthenticated = (request: FastifyRequest) => {
    if (!adminToken || !sessions) return true;
    const credential = presentedCredential(request.headers.authorization);
    return Boolean(credential && (secretsMatch(credential, adminToken) || sessions.verify(credential)));
  };

  /**
   * Where the browser may be sent after connecting an account: a dashboard
   * page on an allowed origin, so the API is never an open redirect.
   */
  const returnOrigins = new Set(config.allowedOrigins);
  if (config.dashboardUrl) returnOrigins.add(new URL(config.dashboardUrl).origin);
  const isAllowedReturnTo = (value: string) => {
    if (value.length > 2048) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && returnOrigins.has(url.origin);
    } catch {
      return false;
    }
  };

  await app.register(rateLimit, { max: config.rateLimit, timeWindow: "1 minute" });

  /**
   * The dashboard is served from a different origin than the API (3000 vs
   * 3001), so browsers need an explicit allow-list (`WEB_ORIGIN`). Credentials
   * travel in the Authorization header, never cookies, and an unlisted origin
   * simply gets no CORS headers.
   */
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.allowedOrigins.size) reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) return;
    reply.header("Access-Control-Allow-Origin", origin);
    if (request.method !== "OPTIONS") return;
    // Preflights carry no Authorization header, so they are answered before the auth check below.
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    reply.header("Access-Control-Max-Age", "600");
    return reply.code(204).send();
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions.config?.public || isAuthenticated(request)) return;
    return reply.code(401).send({ error: "Unauthorized" });
  });

  // Every route replies with JSON only: nosniff and the CSP keep a browser from rendering echoed draft text as HTML.
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    if (request.protocol === "https") reply.header("Strict-Transport-Security", "max-age=31536000");
    if (!reply.hasHeader("location")) reply.type("application/json");
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const known = knownErrorStatus(error);
    if (known) {
      if (known >= 500) logError(request, error);
      return reply.code(known).send({ error: redactSecrets(error.message) });
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status < 500) return reply.code(status).send({ error: redactSecrets(error.message || "Request failed") });
    // Unexpected errors can carry internals (SQL, hostnames); the details go to the log, keyed by request id.
    logError(request, error);
    return reply.code(500).send({ error: "Internal server error", requestId: request.id });
  });

  app.get("/health", { config: { public: true } }, async () => ({ ok: true }));
  /** Readiness: unlike /health this fails when a dependency the API needs is down. */
  app.get("/ready", { config: { public: true } }, async (_request, reply) => {
    if (!deps.checkDatabase) return { ok: true, database: "memory" };
    try {
      await deps.checkDatabase();
      return { ok: true, database: "up" };
    } catch {
      return reply.code(503).send({ ok: false, database: "down" });
    }
  });

  /** Whether the dashboard must sign in, and whether the presented credential is valid. */
  app.get("/auth/session", { config: { public: true } }, async (request) => {
    const credential = presentedCredential(request.headers.authorization);
    const expiresAt = credential ? sessions?.verify(credential) : undefined;
    return {
      required: Boolean(adminToken),
      authenticated: isAuthenticated(request),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    };
  });
  /** Exchanges the admin token for a short-lived session token; tightly rate limited against guessing. */
  app.post(
    "/auth/session",
    { config: { public: true, rateLimit: { max: config.sessionRateLimit, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!adminToken || !sessions) return reply.code(400).send({ error: "Sign-in is not required: ADMIN_TOKEN is not set" });
      const { token } = asBody(request.body);
      if (typeof token !== "string" || !token || token.length > 1024 || !secretsMatch(token, adminToken)) {
        return reply.code(401).send({ error: "Invalid admin token" });
      }
      const session = sessions.issue();
      return reply.code(201).send({ token: session.token, expiresAt: session.expiresAt.toISOString() });
    },
  );
  app.post("/auth/logout", async (request) => {
    const credential = presentedCredential(request.headers.authorization);
    if (credential) sessions?.revoke(credential);
    return { ok: true };
  });

  app.get("/platforms", async () =>
    Object.values(adapters).map(({ id, capabilities, mediaConstraints, textConstraints }) => ({ id, capabilities, mediaConstraints, ...(textConstraints ? { textConstraints } : {}) })),
  );
  app.get("/accounts", async () => accounts.list());
  /** Deletes the account's stored tokens. Revoking the app's access on the platform itself is done in its settings. */
  app.post<{ Params: { id: string } }>("/accounts/:id/disconnect", async (request, reply) => {
    const { id } = request.params;
    if (!id || id.length > 256) return reply.code(400).send({ error: "Invalid account id" });
    const account = await accounts.disconnect(id);
    return account ? { disconnected: account } : reply.code(404).send({ error: "Account not found" });
  });

  app.get("/drafts", async () => posts.list("draft"));
  app.post("/drafts", async (request, reply) => {
    const body = asBody(request.body);
    if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
    const changes = resolveChanges(body, { allowNoPlatforms: true });
    if (changes instanceof Error) return reply.code(400).send({ error: changes.message });
    return reply.code(201).send(await posts.create({ ...changes, text: body.text, media: changes.media ?? [] }));
  });
  /** Updates a draft, scheduled or failed post in place; it keeps its status (409 once the post is publishing or done). */
  app.post<{ Params: { id: string } }>("/drafts/:id", async (request, reply) => {
    if (!isPostId(request.params.id)) return reply.code(400).send({ error: "Invalid draft id" });
    const changes = resolveChanges(asBody(request.body), { allowNoPlatforms: true });
    if (changes instanceof Error) return reply.code(400).send({ error: changes.message });
    // A scheduled post stays queued for the worker, so an edit must leave it publishable, as /schedule requires.
    const existing = await posts.get(request.params.id);
    if (existing?.status === "scheduled") {
      const platforms = changes.platforms ?? existing.platforms;
      if (!platforms.length) return reply.code(400).send({ error: "At least one platform is required" });
      const textError = textLimitError(platforms, changes.text ?? existing.text, changes.platformOverrides ?? existing.platformOverrides);
      if (textError) return reply.code(400).send({ error: textError });
    }
    const draft = await posts.update(request.params.id, changes);
    if (!draft) return reply.code(404).send({ error: "Draft not found" });
    if (!isEditable(draft.status)) return reply.code(409).send({ error: `Post is already ${draft.status}`, post: draft });
    return draft;
  });

  /** Queues a post for the scheduler worker to publish at `scheduledFor`. */
  app.post("/schedule", async (request, reply) => {
    const body = asBody(request.body);
    const { platforms, scheduledFor, id } = body;
    const platformError = validatePlatforms(platforms);
    if (platformError) return reply.code(400).send({ error: platformError });
    const targets = platforms as PlatformId[];
    const when = new Date(typeof scheduledFor === "string" ? scheduledFor : "");
    if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: "scheduledFor must be an ISO 8601 date-time" });
    // Text or media left out of the body keep their stored values, so
    // `{ id, platforms, scheduledFor }` queues a saved draft as it is.
    const changes = resolveChanges(body, { allowNoPlatforms: false });
    if (changes instanceof Error) return reply.code(400).send({ error: changes.message });

    if (id !== undefined) {
      if (typeof id !== "string" || !isPostId(id)) return reply.code(400).send({ error: "Invalid post id" });
      const existing = await posts.get(id);
      if (!existing) return reply.code(404).send({ error: "Post not found" });
      if (isEditable(existing.status)) {
        const textError = textLimitError(targets, changes.text ?? existing.text, changes.platformOverrides ?? existing.platformOverrides);
        if (textError) return reply.code(400).send({ error: textError });
      }
      // The content changes and the status transition are applied together, and
      // only from a status that may be queued — a published, cancelled or
      // already claimed post is reported as a conflict instead.
      const scheduled = await posts.schedule(id, when, changes);
      if (!scheduled) return reply.code(404).send({ error: "Post not found" });
      if (scheduled.status !== "scheduled") return reply.code(409).send({ error: `Post is already ${scheduled.status}`, post: scheduled });
      return reply.code(201).send(scheduled);
    }
    if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
    const textError = textLimitError(targets, body.text, changes.platformOverrides);
    if (textError) return reply.code(400).send({ error: textError });
    return reply.code(201).send(await posts.create({ ...changes, text: body.text, media: changes.media ?? [], platforms: targets, scheduledFor: when }));
  });

  app.get<{ Querystring: { status?: string } }>("/posts", async (request, reply) => {
    const { status } = request.query;
    if (status && !isPostStatus(status)) return reply.code(400).send({ error: `Unknown status: ${status.slice(0, 50)}` });
    return posts.list(status as PostStatus | undefined);
  });
  app.get<{ Params: { id: string } }>("/posts/:id", async (request, reply) => {
    if (!isPostId(request.params.id)) return reply.code(400).send({ error: "Invalid post id" });
    const post = await posts.get(request.params.id);
    return post ?? reply.code(404).send({ error: "Post not found" });
  });
  /**
   * Publishes a stored draft, scheduled or failed post right away, applying any
   * `{ text, media, platforms, platformOverrides }` in the body first.
   * Platforms that already succeeded are skipped, which makes this the retry
   * for a partially failed post. Responds with the settled post and this
   * attempt's per-platform results.
   */
  app.post<{ Params: { id: string } }>("/posts/:id/publish", async (request, reply) => {
    if (!isPostId(request.params.id)) return reply.code(400).send({ error: "Invalid post id" });
    const changes = resolveChanges(asBody(request.body), { allowNoPlatforms: false });
    if (changes instanceof Error) return reply.code(400).send({ error: changes.message });
    const existing = await posts.get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "Post not found" });
    if (isEditable(existing.status)) {
      const platforms = changes.platforms ?? existing.platforms;
      if (!platforms.length) return reply.code(400).send({ error: "At least one platform is required" });
      // Checked for every platform up front, so an over-long text is not published to some platforms and refused by others.
      const textError = textLimitError(platforms, changes.text ?? existing.text, changes.platformOverrides ?? existing.platformOverrides);
      if (textError) return reply.code(400).send({ error: textError });
    }
    const published = await posts.publishNow(request.params.id, postPublisher, changes);
    if (!published) return reply.code(404).send({ error: "Post not found" });
    if (!published.claimed) return reply.code(409).send({ error: `Post is already ${published.post.status}`, post: published.post });
    return { post: published.post, results: published.results };
  });
  /** Cancelling is a no-op once the worker has claimed the post — its platform calls are already in flight. */
  app.post<{ Params: { id: string } }>("/posts/:id/cancel", async (request, reply) => {
    if (!isPostId(request.params.id)) return reply.code(400).send({ error: "Invalid post id" });
    const post = await posts.cancel(request.params.id);
    if (!post) return reply.code(404).send({ error: "Post not found" });
    if (post.status !== "cancelled") return reply.code(409).send({ error: `Post is already ${post.status}`, post });
    return post;
  });

  /**
   * Starts connecting an account. Browsers can't add the Authorization header
   * to a navigation, so the dashboard asks for JSON (`{ url }`) and navigates
   * itself; other clients get the redirect. `returnTo` is the dashboard page
   * the callback sends the browser back to.
   */
  app.get<{ Params: { platform: string }; Querystring: { returnTo?: string } }>("/api/oauth/:platform/start", async (request, reply) => {
    const { platform } = request.params;
    const { returnTo } = request.query;
    if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
    if (returnTo !== undefined && !isAllowedReturnTo(returnTo)) {
      return reply.code(400).send({ error: "returnTo must be a dashboard URL on an origin listed in WEB_ORIGIN" });
    }
    const url = adapters[platform].getAuthUrl(states.create(platform, returnTo));
    return request.headers.accept?.includes("application/json") ? { url } : reply.redirect(url, 302);
  });

  app.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/oauth/:platform/callback",
    // The only unauthenticated write path: authenticated by its signed, single-use `state`, and rate limited tightly.
    { config: { public: true, rateLimit: { max: config.callbackRateLimit, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { platform } = request.params;
      const { code, state, error } = request.query;
      if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
      const verified = typeof state === "string" ? states.consume(state, platform) : undefined;
      if (!verified) return reply.code(400).send({ error: "Invalid or expired OAuth state" });

      /** Back to the dashboard page that started the flow (or BASE_URL's setup page), with the outcome in the query. */
      const finish = (outcome: Record<string, string>, status: number, body: unknown) => {
        const page = verified.returnTo ?? (config.dashboardUrl ? `${config.dashboardUrl.replace(/\/$/, "")}/setup` : undefined);
        if (!page) return reply.code(status).send(body);
        const url = new URL(page);
        for (const [key, value] of Object.entries(outcome)) url.searchParams.set(key, value);
        return reply.redirect(url.toString(), 302);
      };
      if (error || typeof code !== "string" || !code) {
        const message = error ? `${platform} denied the authorization request` : "The platform returned no authorization code";
        return finish({ platform, oauth_error: message }, 400, { error: message });
      }
      try {
        const adapter = adapters[platform];
        const token = await adapter.exchangeCode(code);
        const profile = await adapter.getProfile(token);
        const account = await accounts.connect(platform, profile, { ...token, externalId: token.externalId ?? profile.id });
        return finish({ connected: platform }, 200, account);
      } catch (caught) {
        const known = knownErrorStatus(caught);
        const status = known ?? 500;
        if (status >= 500) logError(request, caught);
        // Platform and configuration errors explain themselves; anything else (a database error, say) stays in the log.
        const message =
          known !== undefined && caught instanceof Error
            ? redactSecrets(caught.message).slice(0, 300)
            : `Connecting the account failed; the API log has the details (request ${request.id})`;
        return finish({ platform, oauth_error: message }, status, { error: message });
      }
    },
  );

  /** Publishes without saving a post; returns a per-platform `status`. */
  app.post("/publish", async (request, reply) => {
    const body = asBody(request.body);
    const platformError = validatePlatforms(body.platforms);
    if (platformError) return reply.code(400).send({ error: platformError });
    const platforms = body.platforms as PlatformId[];
    if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
    const changes = resolveChanges(body, { allowNoPlatforms: false });
    if (changes instanceof Error) return reply.code(400).send({ error: changes.message });
    const textError = textLimitError(platforms, body.text, changes.platformOverrides);
    if (textError) return reply.code(400).send({ error: textError });
    const draft: PostDraft = {
      text: body.text,
      media: changes.media ?? [],
      ...(hasOverrides(changes.platformOverrides) ? { perPlatformOverrides: changes.platformOverrides } : {}),
    };

    return Promise.all(
      platforms.map(async (platform) => {
        try {
          const result = await publisher.publish(platform, draft);
          return { platform, status: "published" as const, ...result };
        } catch (error) {
          return { platform, status: "failed" as const, error: redactSecrets(error instanceof Error ? error.message : "Publishing failed") };
        }
      }),
    );
  });

  /** Media compatibility for a draft, per platform — lets clients warn before publishing. */
  app.post("/media/validate", async (request, reply) => {
    const media = resolveMedia(asBody(request.body));
    if (media instanceof Error) return reply.code(400).send({ error: media.message });
    return Object.values(adapters).map((adapter) => {
      try {
        validateMedia(adapter.id, adapter.capabilities, adapter.mediaConstraints, media);
        return { platform: adapter.id, compatible: true };
      } catch (error) {
        return { platform: adapter.id, compatible: false, reason: error instanceof Error ? error.message : "Incompatible media" };
      }
    });
  });

  app.get<{ Params: { platform: string; postId: string } }>("/analytics/:platform/:postId", async (request, reply) => {
    const { platform, postId } = request.params;
    if (!isPlatform(platform)) return reply.code(404).send({ error: "Unknown platform" });
    if (!isPlatformPostId(postId)) return reply.code(400).send({ error: "Invalid post id" });
    return adapters[platform].getAnalytics(await publisher.tokenFor(platform), { platformPostId: postId });
  });

  return app;
}
