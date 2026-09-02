import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth `state` is an HMAC-signed, time-limited value rather than a random
 * value held in server memory, so the callback can be verified statelessly
 * (and across restarts or multiple API instances) while still blocking CSRF.
 */
const TTL_MS = 10 * 60_000;

function secret(): Buffer {
  const value = process.env.OAUTH_STATE_SECRET ?? process.env.ADMIN_TOKEN ?? process.env.ENCRYPTION_KEY;
  if (!value) throw new Error("Set OAUTH_STATE_SECRET, ADMIN_TOKEN, or ENCRYPTION_KEY to sign OAuth state");
  return Buffer.from(value, "utf8");
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function createState(platform: string): string {
  const payload = `${platform}.${Date.now()}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string, platform: string, now = Date.now()): boolean {
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [statePlatform, issuedAt, , signature] = parts;
  const expected = Buffer.from(sign(parts.slice(0, 3).join(".")), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  if (statePlatform !== platform) return false;
  const issued = Number(issuedAt);
  return Number.isFinite(issued) && now - issued >= 0 && now - issued < TTL_MS;
}
