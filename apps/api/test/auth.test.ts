import { describe, expect, it } from "vitest";
import { createSessions, presentedCredential, secretsMatch } from "../src/auth.js";

const adminToken = "a".repeat(40);
const hour = 3_600_000;

describe("admin credentials", () => {
  it("compares secrets of any length", () => {
    expect(secretsMatch(adminToken, adminToken)).toBe(true);
    expect(secretsMatch(adminToken.slice(1), adminToken)).toBe(false);
    expect(secretsMatch("", adminToken)).toBe(false);
  });

  it("reads bearer and bare Authorization values", () => {
    expect(presentedCredential("Bearer abc")).toBe("abc");
    expect(presentedCredential("bearer   abc")).toBe("abc");
    expect(presentedCredential("abc")).toBe("abc");
    expect(presentedCredential("Bearer ")).toBeUndefined();
    expect(presentedCredential(undefined)).toBeUndefined();
  });
});

describe("dashboard sessions", () => {
  it("verifies a session until it expires", () => {
    const sessions = createSessions(adminToken, hour);
    const now = Date.now();
    const { token, expiresAt } = sessions.issue(now);
    expect(sessions.verify(token, now + 1_000)).toEqual(expiresAt);
    expect(sessions.verify(token, now + hour)).toBeUndefined();
  });

  it("rejects tampered sessions and sessions signed with another admin token", () => {
    const sessions = createSessions(adminToken, hour);
    const { token } = sessions.issue();
    const [prefix, issued, expiry, nonce, signature] = token.split(".");
    expect(sessions.verify(`${prefix}.${Number(issued) + 1}.${expiry}.${nonce}.${signature}`)).toBeUndefined();
    expect(sessions.verify(`${prefix}.${issued}.${Number(expiry) + 1}.${nonce}.${signature}`)).toBeUndefined();
    expect(sessions.verify(adminToken)).toBeUndefined();
    expect(createSessions("b".repeat(40), hour).verify(token)).toBeUndefined();
  });

  it("enforces a lowered TTL from issuance without reactivating old sessions", () => {
    const now = Date.now();
    const { token } = createSessions(adminToken, 12 * hour).issue(now);
    const sessions = createSessions(adminToken, hour);
    expect(sessions.verify(token, now + 30 * 60_000)).toEqual(new Date(now + hour));
    expect(sessions.verify(token, now + hour)).toBeUndefined();
    expect(sessions.verify(token, now + 11 * hour)).toBeUndefined();
    expect(sessions.verify(token, now - 1)).toBeUndefined();
  });

  it("does not extend the signed expiry when the TTL increases", () => {
    const now = Date.now();
    const { token, expiresAt } = createSessions(adminToken, hour).issue(now);
    expect(createSessions(adminToken, 12 * hour).verify(token, now + 1)).toEqual(expiresAt);
    expect(createSessions(adminToken, 12 * hour).verify(token, now + hour)).toBeUndefined();
  });

  it("rejects legacy sessions without an issuance timestamp", () => {
    expect(createSessions(adminToken, hour).verify("s1.9999999999999.nonce.signature")).toBeUndefined();
  });

  it("revokes a session without affecting others", () => {
    const sessions = createSessions(adminToken, hour);
    const first = sessions.issue();
    const second = sessions.issue();
    sessions.revoke(first.token);
    expect(sessions.verify(first.token)).toBeUndefined();
    expect(sessions.verify(second.token)).toEqual(second.expiresAt);
  });
});
