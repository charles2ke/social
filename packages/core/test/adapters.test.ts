import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError, PlatformApiError, UnsupportedOperation, createAdapters, isExpired, redactSecrets } from "../src/index.js";

type Call = { url: string; init?: RequestInit };

/** Records outbound calls and replays queued responses, so no network is used. */
function stubFetch(responses: (Partial<Response> | { status?: number; body?: unknown; headers?: Record<string, string> })[]) {
  const calls: Call[] = [];
  let index = 0;
  const doFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = (responses[index++] ?? { body: {} }) as { status?: number; body?: unknown; headers?: Record<string, string> };
    const status = next.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: new Headers(next.headers ?? {}),
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {})),
    } as Response;
  };
  return { calls, doFetch };
}

const env = {
  MOCK_MODE: "false",
  BASE_URL: "https://social.example",
  LINKEDIN_CLIENT_ID: "li-id",
  LINKEDIN_CLIENT_SECRET: "li-secret",
  META_CLIENT_ID: "meta-id",
  META_CLIENT_SECRET: "meta-secret",
  WHATSAPP_PHONE_NUMBER_ID: "555",
  WHATSAPP_RECIPIENTS: "+15550001111",
  STRAVA_CLIENT_ID: "strava-id",
  STRAVA_CLIENT_SECRET: "strava-secret",
};

const token = { accessToken: "token-value", externalId: "acct-1" };

describe("oauth", () => {
  it("builds a platform authorize URL with the documented callback", () => {
    const { doFetch } = stubFetch([]);
    const url = new URL(createAdapters({ env, fetch: doFetch }).linkedin.getAuthUrl("state-1"));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("client_id")).toBe("li-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://social.example/api/oauth/linkedin/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")).toContain("w_member_social");
  });

  it("reports missing credentials instead of calling the platform", () => {
    const { doFetch } = stubFetch([]);
    expect(() => createAdapters({ env: { MOCK_MODE: "false", BASE_URL: "https://x" }, fetch: doFetch }).linkedin.getAuthUrl("s")).toThrow(ConfigurationError);
  });

  it("exchanges an authorization code for a token set", async () => {
    const { calls, doFetch } = stubFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } }]);
    const result = await createAdapters({ env, fetch: doFetch }).linkedin.exchangeCode("code-1");
    expect(result.accessToken).toBe("at");
    expect(result.refreshToken).toBe("rt");
    expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(calls[0].url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(String(calls[0].init?.body)).toContain("grant_type=authorization_code");
  });

  it("keeps the previous refresh token when the platform omits it", async () => {
    const { calls, doFetch } = stubFetch([{ body: { access_token: "new", expires_in: 60 } }]);
    const refreshed = await createAdapters({ env, fetch: doFetch }).linkedin.refreshToken({ accessToken: "old", refreshToken: "rt", externalId: "acct-1" });
    expect(refreshed).toMatchObject({ accessToken: "new", refreshToken: "rt", externalId: "acct-1" });
    expect(String(calls[0].init?.body)).toContain("grant_type=refresh_token");
  });

  it("does not call the token endpoint for non-refreshable platforms", async () => {
    const { calls, doFetch } = stubFetch([]);
    const unchanged = await createAdapters({ env, fetch: doFetch }).facebook.refreshToken({ accessToken: "long-lived", refreshToken: "rt" });
    expect(unchanged.accessToken).toBe("long-lived");
    expect(calls).toHaveLength(0);
  });

  it("treats tokens inside the refresh skew as expired", () => {
    expect(isExpired({ accessToken: "a", expiresAt: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isExpired({ accessToken: "a", expiresAt: new Date(Date.now() + 3_600_000) })).toBe(false);
    expect(isExpired({ accessToken: "a" })).toBe(false);
  });

  it("reads Strava's absolute expiry and athlete id", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 21_600;
    const { doFetch } = stubFetch([{ body: { access_token: "at", refresh_token: "rt", expires_at: expiresAt, athlete: { id: 42 } } }]);
    const result = await createAdapters({ env, fetch: doFetch }).strava.exchangeCode("code");
    expect(result.externalId).toBe("42");
    expect(result.expiresAt!.getTime()).toBe(expiresAt * 1000);
  });
});

describe("publishing", () => {
  it("posts LinkedIn share content for the connected member", async () => {
    const { calls, doFetch } = stubFetch([{ body: { id: "urn:li:share:1" } }]);
    const result = await createAdapters({ env, fetch: doFetch }).linkedin.publish(token, { text: "Hello" });
    expect(calls[0].url).toBe("https://api.linkedin.com/v2/ugcPosts");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.author).toBe("urn:li:person:acct-1");
    expect(body.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text).toBe("Hello");
    expect(result.platformPostId).toBe("urn:li:share:1");
  });

  it("creates and then publishes an Instagram media container", async () => {
    const { calls, doFetch } = stubFetch([{ body: { id: "container-1" } }, { body: { id: "media-1" } }]);
    const result = await createAdapters({ env, fetch: doFetch }).instagram.publish(token, { text: "Caption", mediaUrls: ["https://cdn.example/a.jpg"] });
    expect(calls.map((call) => call.url)).toEqual([
      "https://graph.facebook.com/v21.0/acct-1/media",
      "https://graph.facebook.com/v21.0/acct-1/media_publish",
    ]);
    expect(JSON.parse(String(calls[1].init?.body)).creation_id).toBe("container-1");
    expect(result.platformPostId).toBe("media-1");
  });

  it("rejects Instagram posts without media", async () => {
    const { doFetch } = stubFetch([]);
    await expect(createAdapters({ env, fetch: doFetch }).instagram.publish(token, { text: "No media" })).rejects.toThrow(/image or video/);
  });

  it("applies per-platform overrides", async () => {
    const { calls, doFetch } = stubFetch([{ body: { id: "post-1" } }]);
    await createAdapters({ env, fetch: doFetch }).facebook.publish(token, { text: "Generic", perPlatformOverrides: { facebook: { text: "Tailored" } } });
    expect(JSON.parse(String(calls[0].init?.body)).message).toBe("Tailored");
  });

  it("requires a connected account before publishing", async () => {
    const { doFetch } = stubFetch([]);
    await expect(createAdapters({ env, fetch: doFetch }).facebook.publish({ accessToken: "t" }, { text: "Hi" })).rejects.toThrow(ConfigurationError);
  });

  it("requires WhatsApp recipients to be configured", async () => {
    const { doFetch } = stubFetch([]);
    const adapters = createAdapters({ env: { ...env, WHATSAPP_RECIPIENTS: "" }, fetch: doFetch });
    await expect(adapters.whatsapp.publish(token, { text: "Hi" })).rejects.toThrow(/WHATSAPP_RECIPIENTS/);
  });

  it("surfaces platform API failures with the status code", async () => {
    const { doFetch } = stubFetch([{ status: 400, body: { error: { message: "Invalid parameter" } } }]);
    await expect(createAdapters({ env, fetch: doFetch }).facebook.publish(token, { text: "Hi" })).rejects.toBeInstanceOf(PlatformApiError);
  });

  it("refuses to publish to platforms without a public publishing API", async () => {
    const { doFetch } = stubFetch([]);
    const adapters = createAdapters({ env, fetch: doFetch });
    await expect(adapters.snapchat.publish(token, { text: "Hi" })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(adapters.substack.publish(token, { text: "Hi" })).rejects.toBeInstanceOf(UnsupportedOperation);
  });

  it("explains why a platform cannot publish instead of a generic message", async () => {
    const { doFetch } = stubFetch([]);
    const adapters = createAdapters({ env, fetch: doFetch });
    await expect(adapters.substack.publish(token, { text: "Hi" })).rejects.toThrow("Substack has no public publishing API");
    await expect(adapters.snapchat.publish(token, { text: "Hi" })).rejects.toThrow("Snapchat has no public organic publishing API");
  });

  it("sends WhatsApp messages with bounded concurrency", async () => {
    const recipients = Array.from({ length: 7 }, (_, index) => `+1555000${index}`);
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push(String(JSON.parse(String(init?.body)).to));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ messages: [{ id: `msg-${url.length}` }] }) } as Response;
    };
    const adapters = createAdapters({ env: { ...env, WHATSAPP_RECIPIENTS: recipients.join(","), WHATSAPP_SEND_CONCURRENCY: "2" }, fetch: doFetch });
    await expect(adapters.whatsapp.publish(token, { text: "Hi" })).resolves.toMatchObject({ platformPostId: expect.any(String) });
    expect(calls).toHaveLength(recipients.length);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("still publishes to WhatsApp when a single recipient fails, and fails when all do", async () => {
    const failFirst = stubFetch([{ status: 400, body: { error: { message: "Invalid number" } } }, { body: { messages: [{ id: "msg-2" }] } }]);
    const twoRecipients = { ...env, WHATSAPP_RECIPIENTS: "+15550001111,+15550002222", WHATSAPP_SEND_CONCURRENCY: "1" };
    await expect(createAdapters({ env: twoRecipients, fetch: failFirst.doFetch }).whatsapp.publish(token, { text: "Hi" })).resolves.toMatchObject({ platformPostId: "msg-2" });

    const allFail = stubFetch([{ status: 400, body: { error: { message: "Invalid number" } } }, { status: 400, body: { error: { message: "Invalid number" } } }]);
    await expect(createAdapters({ env: twoRecipients, fetch: allFail.doFetch }).whatsapp.publish(token, { text: "Hi" })).rejects.toBeInstanceOf(PlatformApiError);
  });
});

describe("connecting an account", () => {
  it("resolves the Facebook Page that publishing targets, not the /me user", async () => {
    const { calls, doFetch } = stubFetch([{ body: { data: [{ id: "page-1", name: "Test Page" }] } }]);
    await expect(createAdapters({ env, fetch: doFetch }).facebook.getProfile(token)).resolves.toEqual({ id: "page-1", name: "Test Page" });
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/me/accounts?fields=id,name");
  });

  it("selects the configured Facebook Page and reports when it is absent", async () => {
    const picked = stubFetch([{ body: { data: [{ id: "page-1" }, { id: "page-2", name: "Second" }] } }]);
    const withPage = { ...env, FACEBOOK_PAGE_ID: "page-2" };
    await expect(createAdapters({ env: withPage, fetch: picked.doFetch }).facebook.getProfile(token)).resolves.toEqual({ id: "page-2", name: "Second" });

    const missing = stubFetch([{ body: { data: [{ id: "page-1" }] } }]);
    await expect(createAdapters({ env: withPage, fetch: missing.doFetch }).facebook.getProfile(token)).rejects.toThrow(/page-2/);
  });

  it("resolves the linked Instagram Business account id", async () => {
    const { calls, doFetch } = stubFetch([
      { body: { data: [{ id: "page-1" }, { id: "page-2", instagram_business_account: { id: "ig-9", username: "brand" } }] } },
    ]);
    await expect(createAdapters({ env, fetch: doFetch }).instagram.getProfile(token)).resolves.toEqual({ id: "ig-9", name: "brand" });
    expect(calls[0].url).toContain("instagram_business_account");
  });

  it("reports when no Instagram Business account is linked", async () => {
    const { doFetch } = stubFetch([{ body: { data: [{ id: "page-1" }] } }]);
    await expect(createAdapters({ env, fetch: doFetch }).instagram.getProfile(token)).rejects.toThrow(/Instagram Business account/);
  });
});

describe("analytics", () => {
  it("maps Facebook insights onto the shared metrics shape", async () => {
    const { doFetch } = stubFetch([
      { body: { data: [{ name: "post_impressions", values: [{ value: 120 }] }, { name: "post_engaged_users", values: [{ value: 9 }] }] } },
      { body: { likes: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } } } },
    ]);
    await expect(createAdapters({ env, fetch: doFetch }).facebook.getAnalytics(token, { platformPostId: "1_2" })).resolves.toEqual({
      impressions: 120,
      engagements: 9,
      likes: 5,
      comments: 2,
    });
  });

  it("refuses analytics for platforms that do not expose them", async () => {
    const { doFetch } = stubFetch([]);
    await expect(createAdapters({ env, fetch: doFetch }).strava.getAnalytics(token, { platformPostId: "1" })).rejects.toBeInstanceOf(UnsupportedOperation);
  });
});

describe("secret handling", () => {
  it("redacts tokens from anything that can reach an error message or log", () => {
    const redacted = redactSecrets('{"access_token":"abc","refresh_token":"def"} client_secret=xyz&code=123');
    expect(redacted).not.toMatch(/abc|def|xyz|123/);
    expect(redacted).toContain("[redacted]");
  });

  it("keeps platform tokens out of API error messages", async () => {
    const { doFetch } = stubFetch([{ status: 401, body: { access_token: "token-value" } }]);
    await expect(createAdapters({ env, fetch: doFetch }).facebook.publish(token, { text: "Hi" })).rejects.toThrow(/\[redacted\]/);
  });

  it("keeps the stored PlatformApiError detail redacted too", async () => {
    const { doFetch } = stubFetch([{ status: 401, body: { access_token: "token-value" } }]);
    const error = await createAdapters({ env, fetch: doFetch }).facebook.publish(token, { text: "Hi" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).detail).not.toContain("token-value");
    expect((error as PlatformApiError).detail).toContain("[redacted]");
  });
});

describe("mock mode", () => {
  beforeEach(() => {
    process.env.MOCK_MODE = "true";
  });

  it("never contacts a platform", async () => {
    const { calls, doFetch } = stubFetch([]);
    const adapters = createAdapters({ env: { MOCK_MODE: "true" }, fetch: doFetch });
    const result = await adapters.linkedin.publish({ accessToken: "mock" }, { text: "Hello" });
    expect(result.platformPostId).toMatch(/^linkedin-/);
    expect(adapters.linkedin.getAuthUrl("s")).toContain("auth.linkedin.example");
    expect(calls).toHaveLength(0);
  });
});
