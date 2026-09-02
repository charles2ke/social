import { ConfigurationError, type FetchLike, requestJson } from "./http.js";
import type { PlatformId, TokenSet } from "./types.js";

export type Env = Record<string, string | undefined>;

/** Raw OAuth token endpoint payload, normalised by `parseTokenResponse`. */
export type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Strava returns an absolute unix timestamp instead of a lifetime. */
  expires_at?: number;
  open_id?: string;
  athlete?: { id?: number | string };
};

export type OAuthSpec = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** False for platforms that issue long-lived, non-refreshable tokens. */
  refreshable: boolean;
  /** TikTok names its credentials `client_key`/`client_secret`. */
  clientIdParam?: string;
  /** Extra static query parameters required by the authorize endpoint. */
  authorizeParams?: Record<string, string>;
  /** Extra headers required by the token endpoint. */
  tokenHeaders?: Record<string, string>;
};

export function credentials(platform: PlatformId, spec: OAuthSpec, env: Env) {
  const clientId = env[spec.clientIdEnv];
  const clientSecret = env[spec.clientSecretEnv];
  if (!clientId || !clientSecret) throw new ConfigurationError(platform, `${spec.clientIdEnv} and ${spec.clientSecretEnv}`);
  return { clientId, clientSecret };
}

/**
 * Where the platform sends the user back. Documented in `.env.example` as
 * `BASE_URL/api/oauth/<platform>/callback`; `OAUTH_REDIRECT_BASE_URL` allows
 * pointing at the API origin when it differs from the dashboard origin.
 */
export function redirectUri(platform: PlatformId, env: Env): string {
  const base = env.OAUTH_REDIRECT_BASE_URL ?? env.BASE_URL;
  if (!base) throw new ConfigurationError(platform, "BASE_URL (or OAUTH_REDIRECT_BASE_URL)");
  return `${base.replace(/\/$/, "")}/api/oauth/${platform}/callback`;
}

export function buildAuthorizeUrl(platform: PlatformId, spec: OAuthSpec, env: Env, state: string): string {
  const { clientId } = credentials(platform, spec, env);
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set(spec.clientIdParam ?? "client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(platform, env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.scopes.join(spec.clientIdParam === "client_key" ? "," : " "));
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(spec.authorizeParams ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export function parseTokenResponse(raw: RawTokenResponse, previous?: TokenSet): TokenSet {
  const accessToken = raw.access_token;
  if (!accessToken) throw new Error("Token endpoint response did not include an access token");
  const expiresAt = raw.expires_at
    ? new Date(raw.expires_at * 1000)
    : raw.expires_in
      ? new Date(Date.now() + raw.expires_in * 1000)
      : undefined;
  const externalId = raw.open_id ?? (raw.athlete?.id !== undefined ? String(raw.athlete.id) : undefined) ?? previous?.externalId;
  return { accessToken, refreshToken: raw.refresh_token ?? previous?.refreshToken, expiresAt, externalId };
}

async function postForm(platform: PlatformId, spec: OAuthSpec, doFetch: FetchLike, body: Record<string, string>) {
  return requestJson<RawTokenResponse>(platform, doFetch, spec.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...spec.tokenHeaders },
    body: new URLSearchParams(body).toString(),
  });
}

export async function exchangeAuthorizationCode(platform: PlatformId, spec: OAuthSpec, env: Env, doFetch: FetchLike, code: string): Promise<TokenSet> {
  const { clientId, clientSecret } = credentials(platform, spec, env);
  const raw = await postForm(platform, spec, doFetch, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(platform, env),
    [spec.clientIdParam ?? "client_id"]: clientId,
    client_secret: clientSecret,
  });
  return parseTokenResponse(raw);
}

export async function refreshAccessToken(platform: PlatformId, spec: OAuthSpec, env: Env, doFetch: FetchLike, token: TokenSet): Promise<TokenSet> {
  if (!spec.refreshable || !token.refreshToken) return token;
  const { clientId, clientSecret } = credentials(platform, spec, env);
  const raw = await postForm(platform, spec, doFetch, {
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    [spec.clientIdParam ?? "client_id"]: clientId,
    client_secret: clientSecret,
  });
  return parseTokenResponse(raw, token);
}

/** Tokens are refreshed slightly early so an in-flight publish cannot race expiry. */
export const REFRESH_SKEW_MS = 5 * 60_000;

export function isExpired(token: TokenSet, now = new Date()): boolean {
  return token.expiresAt !== undefined && token.expiresAt.getTime() - REFRESH_SKEW_MS <= now.getTime();
}
