import { randomBytes } from "node:crypto";
import { assertEncryptionKey } from "@social/core";
import { numberEnv, stringEnv, type Env } from "./env.js";

export const MIN_ADMIN_TOKEN_LENGTH = 32;

export type ApiConfig = {
  mockMode: boolean;
  /** Unset only in mock mode, where the API is open (and listens on localhost by default). */
  adminToken?: string;
  sessionTtlMs: number;
  /** Browser origins allowed to call the API, and to be returned to after connecting an account. */
  allowedOrigins: ReadonlySet<string>;
  /** The dashboard's public URL: where a browser lands after connecting an account when it gave no `returnTo`. */
  dashboardUrl?: string;
  oauthStateSecret: string;
  bodyLimit: number;
  rateLimit: number;
  callbackRateLimit: number;
  sessionRateLimit: number;
  trustProxy: boolean | number | string;
  host: string;
  port: number;
};

function origin(value: string, name: string): string {
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* reported below */ }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  return url.origin;
}

function trustProxy(env: Env): boolean | number | string {
  const value = stringEnv(env, "TRUST_PROXY");
  if (!value || value === "false") return false;
  if (value === "true") return true;
  // A hop count, or a comma-separated list of proxy addresses/CIDRs.
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Reads and validates the API's settings, failing at startup rather than at the first request. */
export function loadConfig(env: Env = process.env): ApiConfig {
  // Exactly the check the platform adapters use, so the API never treats itself as a mock while adapters call real platforms.
  const mockMode = env.MOCK_MODE === "true";
  const adminToken = stringEnv(env, "ADMIN_TOKEN");
  if (!adminToken && !mockMode) {
    throw new Error("ADMIN_TOKEN must be set outside mock mode — the API exposes account and publishing endpoints. Generate one with: openssl rand -hex 32");
  }
  if (adminToken && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`);
  }
  // Tokens are encrypted before they reach the database, so a bad key must stop startup, not the first OAuth callback.
  if (stringEnv(env, "DATABASE_URL")) assertEncryptionKey();

  const dashboardUrl = stringEnv(env, "BASE_URL");
  if (dashboardUrl) origin(dashboardUrl, "BASE_URL");
  const allowedOrigins = new Set(
    (stringEnv(env, "WEB_ORIGIN") ?? (mockMode ? "http://localhost:3000" : ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => origin(value, "WEB_ORIGIN")),
  );

  return {
    mockMode,
    adminToken,
    sessionTtlMs: numberEnv(env, "SESSION_TTL_HOURS", 12, { min: 0.1, max: 24 * 30 }) * 3_600_000,
    allowedOrigins,
    dashboardUrl,
    // Without ADMIN_TOKEN (mock mode only) a per-process key still makes state unforgeable.
    oauthStateSecret: stringEnv(env, "OAUTH_STATE_SECRET") ?? adminToken ?? randomBytes(32).toString("hex"),
    bodyLimit: numberEnv(env, "API_BODY_LIMIT", 1_048_576, { min: 1024, integer: true }),
    rateLimit: numberEnv(env, "API_RATE_LIMIT", 300, { min: 1, integer: true }),
    callbackRateLimit: numberEnv(env, "OAUTH_CALLBACK_RATE_LIMIT", 20, { min: 1, integer: true }),
    sessionRateLimit: numberEnv(env, "SESSION_RATE_LIMIT", 10, { min: 1, integer: true }),
    trustProxy: trustProxy(env),
    // An open (mock, no ADMIN_TOKEN) API is only reachable from this machine unless API_HOST says otherwise.
    host: stringEnv(env, "API_HOST") ?? (adminToken ? "0.0.0.0" : "localhost"),
    port: numberEnv(env, "API_PORT", 3001, { min: 0, max: 65_535, integer: true }),
  };
}
