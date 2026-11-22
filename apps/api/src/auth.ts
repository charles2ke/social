import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time comparison that also hides the length of the expected secret. */
export function secretsMatch(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Derives an independent key per purpose from one secret, so e.g. a session signature can never pass as an OAuth state. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "social-api", purpose, 32));
}

/** The credential in an `Authorization` header: a bearer token, or (for older clients) the bare value. */
export function presentedCredential(header: string | undefined): string | undefined {
  const value = header?.replace(/^Bearer\s+/i, "").trim();
  return value || undefined;
}

export type Session = { token: string; expiresAt: Date };

export type Sessions = {
  issue(now?: number): Session;
  /** The session's expiry when `token` is a valid, unexpired and unrevoked session token. */
  verify(token: string, now?: number): Date | undefined;
  revoke(token: string, now?: number): void;
};

const PREFIX = "s1";

/**
 * Short-lived dashboard sessions, so a browser holds a token that expires on
 * its own rather than the admin token itself. A session is
 * `s1.<expiry>.<nonce>.<hmac>`, signed with a key derived from ADMIN_TOKEN:
 * rotating ADMIN_TOKEN ends every session. Signing out revokes one session in
 * this process (sessions are otherwise stateless, so a revocation is not seen
 * by other API instances).
 */
export function createSessions(adminToken: string, ttlMs: number): Sessions {
  const key = deriveKey(adminToken, "dashboard session v1");
  const revoked = new Map<string, number>();
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

  const parse = (token: string, now: number) => {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== PREFIX) return undefined;
    const [, expiry, nonce, signature] = parts as [string, string, string, string];
    if (!secretsMatch(signature, sign(`${PREFIX}.${expiry}.${nonce}`))) return undefined;
    const expiresAt = Number(expiry);
    // A session from before the TTL was lowered must not outlive the new TTL.
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > ttlMs) return undefined;
    return revoked.has(nonce) ? undefined : { nonce, expiresAt };
  };

  return {
    issue(now = Date.now()) {
      const payload = `${PREFIX}.${now + ttlMs}.${randomBytes(16).toString("base64url")}`;
      return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(now + ttlMs) };
    },
    verify(token, now = Date.now()) {
      const session = parse(token, now);
      return session ? new Date(session.expiresAt) : undefined;
    },
    revoke(token, now = Date.now()) {
      const session = parse(token, now);
      for (const [nonce, expiresAt] of revoked) if (expiresAt <= now) revoked.delete(nonce);
      if (session) revoked.set(session.nonce, session.expiresAt);
    },
  };
}
