import { randomUUID } from "node:crypto";
import { ConfigurationError, defaultFetch, type FetchLike, requestJson } from "../http.js";
import { buildAuthorizeUrl, exchangeAuthorizationCode, type Env, type OAuthSpec, refreshAccessToken } from "../oauth.js";
import {
  type Capabilities,
  type Metrics,
  type PlatformAdapter,
  type PlatformId,
  type PostDraft,
  type PostRef,
  type Profile,
  type PublishResult,
  type TokenSet,
  UnsupportedOperation,
} from "../types.js";

export type AdapterContext = {
  platform: PlatformId;
  token: TokenSet;
  env: Env;
  /** Bearer-authenticated JSON request against the platform's API. */
  request<T>(url: string, init?: RequestInit): Promise<T>;
  fetch: FetchLike;
};

export type PlatformSpec = {
  id: PlatformId;
  capabilities: Capabilities;
  oauth?: OAuthSpec;
  getProfile?(ctx: AdapterContext): Promise<Profile>;
  publish?(ctx: AdapterContext, post: PostDraft): Promise<PublishResult>;
  getAnalytics?(ctx: AdapterContext, ref: PostRef): Promise<Metrics>;
  /** Set when the platform has no public API for publishing at all. */
  publishUnsupported?: string;
};

export type AdapterDeps = { fetch?: FetchLike; env?: Env };

/** The account id a platform's endpoints are scoped to, captured at connect time. */
export function requireExternalId(ctx: AdapterContext): string {
  if (!ctx.token.externalId) {
    throw new ConfigurationError(ctx.platform, "a connected account (reconnect it so its platform id is stored)");
  }
  return ctx.token.externalId;
}

export function requireEnv(ctx: AdapterContext, name: string): string {
  const value = ctx.env[name];
  if (!value) throw new ConfigurationError(ctx.platform, name);
  return value;
}

const mockMode = (env: Env) => env.MOCK_MODE === "true";

export class ApiAdapter implements PlatformAdapter {
  readonly id: PlatformId;
  readonly capabilities: Capabilities;

  constructor(
    private readonly spec: PlatformSpec,
    private readonly deps: AdapterDeps = {},
  ) {
    this.id = spec.id;
    this.capabilities = spec.capabilities;
  }

  private get env(): Env {
    return this.deps.env ?? process.env;
  }

  private get fetch(): FetchLike {
    return this.deps.fetch ?? defaultFetch;
  }

  private context(token: TokenSet): AdapterContext {
    const platform = this.id;
    const doFetch = this.fetch;
    const authorization = ["Bearer", token.accessToken].join(" ");
    return {
      platform,
      token,
      env: this.env,
      fetch: doFetch,
      request: <T>(url: string, init: RequestInit = {}) =>
        requestJson<T>(platform, doFetch, url, {
          ...init,
          headers: { Authorization: authorization, Accept: "application/json", ...init.headers },
        }),
    };
  }

  private oauth(): OAuthSpec {
    if (!this.spec.oauth) throw new UnsupportedOperation(this.id, "OAuth");
    return this.spec.oauth;
  }

  getAuthUrl(state: string): string {
    if (mockMode(this.env)) return `https://auth.${this.id}.example/authorize?state=${encodeURIComponent(state)}`;
    return buildAuthorizeUrl(this.id, this.oauth(), this.env, state);
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    if (mockMode(this.env)) {
      return { accessToken: `mock-${this.id}-${code}`, expiresAt: new Date(Date.now() + 3_600_000), externalId: `mock-${this.id}` };
    }
    return exchangeAuthorizationCode(this.id, this.oauth(), this.env, this.fetch, code);
  }

  async refreshToken(token: TokenSet): Promise<TokenSet> {
    if (mockMode(this.env)) return { ...token, expiresAt: new Date(Date.now() + 3_600_000) };
    return refreshAccessToken(this.id, this.oauth(), this.env, this.fetch, token);
  }

  async getProfile(token: TokenSet): Promise<Profile> {
    if (mockMode(this.env)) return { id: `mock-${this.id}`, name: `Mock ${this.id}` };
    if (!this.spec.getProfile) throw new UnsupportedOperation(this.id, "profile lookup");
    return this.spec.getProfile(this.context(token));
  }

  async publish(token: TokenSet, post: PostDraft): Promise<PublishResult> {
    if (this.spec.publishUnsupported) throw new UnsupportedOperation(this.id, "publishing");
    const draft = { ...post, ...(post.perPlatformOverrides?.[this.id] ?? {}) };
    if (!draft.text.trim()) throw new Error("Post text is required");
    if (mockMode(this.env)) return { platformPostId: `${this.id}-${randomUUID()}`, publishedAt: new Date() };
    if (!this.spec.publish) throw new UnsupportedOperation(this.id, "publishing until its API client is configured");
    return this.spec.publish(this.context(token), draft);
  }

  async getAnalytics(token: TokenSet, ref: PostRef): Promise<Metrics> {
    if (!this.capabilities.analytics) throw new UnsupportedOperation(this.id, "analytics");
    if (mockMode(this.env)) return { impressions: 0, engagements: 0, likes: 0, comments: 0 };
    if (!this.spec.getAnalytics) throw new UnsupportedOperation(this.id, "analytics until its API client is configured");
    return this.spec.getAnalytics(this.context(token), ref);
  }
}
