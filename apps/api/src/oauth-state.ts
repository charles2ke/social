import { createHmac, randomBytes } from "node:crypto";
import { deriveKey, secretsMatch } from "./auth.js";

/**
 * OAuth `state` is an HMAC-signed, ten-minute value carrying the platform and
 * the dashboard page to return to, so the callback can verify it without
 * server-side session state while still blocking CSRF. Each state is also
 * accepted only once by this process.
 */
const TTL_MS = 10 * 60_000;

export type OAuthStates = {
  create(platform: string, returnTo?: string, now?: number): string;
  /** Verifies a state for `platform` and marks it used; undefined when invalid, expired or already used. */
  consume(state: string, platform: string, now?: number): { returnTo?: string } | undefined;
};

export function createOAuthStates(secret: string): OAuthStates {
  const key = deriveKey(secret, "oauth state v1");
  const used = new Map<string, number>();
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

  return {
    create(platform, returnTo, now = Date.now()) {
      const encoded = returnTo ? Buffer.from(returnTo, "utf8").toString("base64url") : "";
      const payload = `${platform}.${now}.${randomBytes(16).toString("base64url")}.${encoded}`;
      return `${payload}.${sign(payload)}`;
    },
    consume(state, platform, now = Date.now()) {
      const parts = state.split(".");
      if (parts.length !== 5) return undefined;
      const [statePlatform, issuedAt, nonce, encoded, signature] = parts as [string, string, string, string, string];
      if (!secretsMatch(signature, sign(parts.slice(0, 4).join(".")))) return undefined;
      const issued = Number(issuedAt);
      if (statePlatform !== platform || !Number.isFinite(issued) || now < issued || now - issued >= TTL_MS) return undefined;
      for (const [seen, expiresAt] of used) if (expiresAt <= now) used.delete(seen);
      if (used.has(nonce)) return undefined;
      used.set(nonce, issued + TTL_MS);
      return encoded ? { returnTo: Buffer.from(encoded, "base64url").toString("utf8") } : {};
    },
  };
}
