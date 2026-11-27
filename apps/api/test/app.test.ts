import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PostDraft } from "@social/core";
import { type AccountRepository, createMemoryAccountRepository } from "../src/accounts.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMemoryPostRepository, type PostRepository } from "../src/posts.js";
import { createPublisher, type Publisher } from "../src/publisher.js";

const adminToken = "t".repeat(40);
const dashboard = "http://dash.test";
const auth = { authorization: `Bearer ${adminToken}` };

beforeAll(() => {
  vi.stubEnv("MOCK_MODE", "true");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

async function setup(options: { env?: Record<string, string>; posts?: PostRepository; publisher?: Publisher; accounts?: AccountRepository } = {}) {
  const config = loadConfig(options.env ?? { MOCK_MODE: "true", ADMIN_TOKEN: adminToken, WEB_ORIGIN: dashboard, BASE_URL: dashboard });
  const accounts = options.accounts ?? createMemoryAccountRepository();
  return buildApp({
    config,
    accounts,
    posts: options.posts ?? createMemoryPostRepository(),
    publisher: options.publisher ?? createPublisher(accounts, { mockMode: true }),
  });
}

describe("concurrent post validation", () => {
  it.each(["update", "schedule", "publish"] as const)("validates the latest state at %s and returns 400", async (operation) => {
    const repository = createMemoryPostRepository();
    const post = await repository.create({ text: "short", platforms: ["linkedin"] });
    const when = new Date(Date.now() + 60_000);
    const posts: PostRepository = {
      ...repository,
      async update(id, changes) {
        await repository.schedule(id, when);
        return repository.update(id, changes);
      },
      async schedule(id, scheduledFor, changes) {
        await repository.update(id, { text: "x".repeat(3001) });
        return repository.schedule(id, scheduledFor, changes);
      },
      async publishNow(id, publisher, changes) {
        await repository.update(id, { platforms: [] });
        return repository.publishNow(id, publisher, changes);
      },
    };
    const app = await setup({ posts });
    const response = operation === "update"
      ? await app.inject({ method: "POST", url: `/drafts/${post.id}`, headers: auth, payload: { platforms: [] } })
      : operation === "schedule"
        ? await app.inject({ method: "POST", url: "/schedule", headers: auth, payload: { id: post.id, platforms: ["linkedin"], scheduledFor: when.toISOString() } })
        : await app.inject({ method: "POST", url: `/posts/${post.id}/publish`, headers: auth, payload: {} });

    expect(response.statusCode).toBe(400);
    expect((await repository.get(post.id))?.status).toBe(operation === "update" ? "scheduled" : "draft");
    await app.close();
  });
});

describe("authentication", () => {
  it("accepts the admin token or a session minted from it", async () => {
    const app = await setup();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/posts" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/no-such-route" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/posts", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: "/auth/session" })).json()).toEqual({ required: true, authenticated: false });
    expect((await app.inject({ method: "POST", url: "/auth/session", payload: { token: "t".repeat(39) } })).statusCode).toBe(401);

    const signIn = await app.inject({ method: "POST", url: "/auth/session", payload: { token: adminToken } });
    expect(signIn.statusCode).toBe(201);
    const session = { authorization: `Bearer ${signIn.json().token}` };
    expect((await app.inject({ url: "/posts", headers: session })).statusCode).toBe(200);
    expect((await app.inject({ url: "/auth/session", headers: session })).json()).toEqual({ required: true, authenticated: true, expiresAt: signIn.json().expiresAt });

    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: session })).statusCode).toBe(200);
    expect((await app.inject({ url: "/posts", headers: session })).statusCode).toBe(401);
    expect((await app.inject({ url: "/posts", headers: auth })).statusCode).toBe(200);
  });

  it("is open in mock mode without an ADMIN_TOKEN", async () => {
    const app = await setup({ env: { MOCK_MODE: "true" } });
    expect((await app.inject({ url: "/posts" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/auth/session" })).json()).toEqual({ required: false, authenticated: true });
    expect((await app.inject({ method: "POST", url: "/auth/session", payload: { token: "x" } })).statusCode).toBe(400);
  });
});

describe("responses", () => {
  it("sets security headers and allows only listed origins", async () => {
    const app = await setup();
    expect((await app.inject({ url: "/health" })).headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    });
    const preflight = await app.inject({ method: "OPTIONS", url: "/posts", headers: { origin: dashboard, "access-control-request-method": "POST" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(dashboard);
    const foreign = await app.inject({ method: "OPTIONS", url: "/posts", headers: { origin: "http://evil.test", "access-control-request-method": "POST" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("hides unexpected errors behind a request id and logs them redacted", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const posts = { ...createMemoryPostRepository(), list: async () => Promise.reject(new Error("connect ECONNREFUSED db.internal:5432 password=hunter2")) };
    const app = await setup({ posts });

    const response = await app.inject({ url: "/posts", headers: auth });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error", requestId: expect.any(String) });
    expect(String(log.mock.calls[0]?.[0])).toContain("db.internal");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("hunter2");
    log.mockRestore();
  });

  it("rejects malformed bodies and analytics ids with 400", async () => {
    const app = await setup();
    const json = { ...auth, "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/drafts", headers: json, payload: "null" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/publish", headers: json, payload: "[]" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/analytics/linkedin/..%2F..%2Fadmin", headers: auth })).statusCode).toBe(400);
  });
});

describe("per-platform text", () => {
  it("stores overrides, clears them, and publishes them with the post", async () => {
    const seen: PostDraft[] = [];
    const publisher: Publisher = {
      accountFor: async () => undefined,
      tokenFor: async () => ({ accessToken: "t" }),
      publish: async (platform, draft) => {
        seen.push(draft);
        return { platformPostId: `${platform}-1`, publishedAt: new Date() };
      },
    };
    const app = await setup({ publisher });
    const created = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: auth,
      payload: { text: "Main", platforms: ["linkedin", "facebook"], platformOverrides: { linkedin: { text: "For LinkedIn" }, facebook: { text: " " } } },
    });
    expect(created.json()).toMatchObject({ platformOverrides: { linkedin: { text: "For LinkedIn" } } });
    const { id } = created.json();
    expect((await app.inject({ method: "POST", url: `/drafts/${id}`, headers: auth, payload: { platformOverrides: { myspace: { text: "x" } } } })).statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: `/posts/${id}/publish`, headers: auth, payload: {} })).statusCode).toBe(200);
    expect(seen.map((draft) => draft.perPlatformOverrides)).toEqual([{ linkedin: { text: "For LinkedIn" } }, { linkedin: { text: "For LinkedIn" } }]);

    const draft = (await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { text: "x", platformOverrides: { linkedin: { text: "y" } } } })).json();
    const cleared = await app.inject({ method: "POST", url: `/drafts/${draft.id}`, headers: auth, payload: { platformOverrides: {} } });
    expect(cleared.json()).not.toHaveProperty("platformOverrides");
  });

  it("refuses text over a platform's limit before publishing anywhere", async () => {
    const app = await setup();
    const long = "x".repeat(3500);
    const rejected = await app.inject({ method: "POST", url: "/publish", headers: auth, payload: { text: long, platforms: ["facebook", "linkedin"] } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("linkedin posts are limited to 3000 characters, this one has 3500");
    const fitted = await app.inject({ method: "POST", url: "/publish", headers: auth, payload: { text: long, platforms: ["facebook", "linkedin"], platformOverrides: { linkedin: { text: "Short" } } } });
    expect(fitted.json().map((result: { status: string }) => result.status)).toEqual(["published", "published"]);

    const { id } = (await app.inject({ method: "POST", url: "/drafts", headers: auth, payload: { text: long, platforms: ["linkedin"] } })).json();
    expect((await app.inject({ method: "POST", url: `/posts/${id}/publish`, headers: auth, payload: {} })).statusCode).toBe(400);
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    expect((await app.inject({ method: "POST", url: "/schedule", headers: auth, payload: { id, platforms: ["linkedin"], scheduledFor } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/posts/${id}`, headers: auth })).json().status).toBe("draft");
    const scheduled = await app.inject({ method: "POST", url: "/schedule", headers: auth, payload: { id, platforms: ["linkedin"], scheduledFor, platformOverrides: { linkedin: { text: "Short" } } } });
    expect(scheduled.statusCode).toBe(201);

    // A scheduled post stays queued, so editing it may not break a limit or drop every platform.
    const unfitted = await app.inject({ method: "POST", url: `/drafts/${id}`, headers: auth, payload: { platformOverrides: {} } });
    expect(unfitted.statusCode).toBe(400);
    expect(unfitted.json().error).toBe("linkedin posts are limited to 3000 characters, this one has 3500");
    expect((await app.inject({ method: "POST", url: `/drafts/${id}`, headers: auth, payload: { platforms: [] } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/posts/${id}`, headers: auth })).json()).toMatchObject({ status: "scheduled", platforms: ["linkedin"], platformOverrides: { linkedin: { text: "Short" } } });
    const edited = await app.inject({ method: "POST", url: `/drafts/${id}`, headers: auth, payload: { text: "Fits now", platformOverrides: {} } });
    expect(edited.json()).toMatchObject({ status: "scheduled", text: "Fits now" });
  });
});

describe("accounts", () => {
  it("connects through OAuth, returns to the dashboard, and disconnects", async () => {
    const app = await setup();
    const start = await app.inject({ url: `/api/oauth/linkedin/start?returnTo=${encodeURIComponent(`${dashboard}/setup`)}`, headers: { ...auth, accept: "application/json" } });
    const { url } = start.json();

    const callback = await app.inject({ url });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${dashboard}/setup?connected=linkedin`);
    expect((await app.inject({ url })).statusCode).toBe(400);

    const [account] = (await app.inject({ url: "/accounts", headers: auth })).json();
    expect(account).toMatchObject({ platform: "linkedin" });
    const path = `/accounts/${encodeURIComponent(account.id)}/disconnect`;
    expect((await app.inject({ method: "POST", url: path, headers: auth })).json()).toEqual({ disconnected: account });
    expect((await app.inject({ url: "/accounts", headers: auth })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: path, headers: auth })).statusCode).toBe(404);
  });

  it("returns only to dashboard origins and reports a denied authorization", async () => {
    const app = await setup();
    const evil = await app.inject({ url: `/api/oauth/linkedin/start?returnTo=${encodeURIComponent("https://evil.test/setup")}`, headers: auth });
    expect(evil.statusCode).toBe(400);

    const start = await app.inject({ url: "/api/oauth/linkedin/start", headers: auth });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location), "http://api.test").searchParams.get("state") ?? "";
    const denied = await app.inject({ url: `/api/oauth/linkedin/callback?error=access_denied&state=${encodeURIComponent(state)}` });
    const location = new URL(String(denied.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(`${dashboard}/setup`);
    expect(location.searchParams.get("oauth_error")).toBe("linkedin denied the authorization request");
    expect((await app.inject({ url: "/api/oauth/linkedin/callback?code=x&state=forged" })).statusCode).toBe(400);
  });

  it("keeps unexpected connect errors out of the redirect", async () => {
    const accounts = createMemoryAccountRepository();
    accounts.connect = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await setup({ accounts });
    const { url } = (await app.inject({ url: "/api/oauth/linkedin/start", headers: { ...auth, accept: "application/json" } })).json();

    const location = new URL(String((await app.inject({ url })).headers.location));
    expect(location.searchParams.get("oauth_error")).toMatch(/^Connecting the account failed; the API log has the details \(request .+\)$/);
    expect(logged.mock.calls.flat().join("\n")).toContain("ECONNREFUSED");
    logged.mockRestore();
  });
});
