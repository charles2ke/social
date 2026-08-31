import { afterAll, beforeEach, describe, expect, it } from "vitest";
// Imported directly from source (not the `@social/core` package specifier)
// so this test never depends on `@social/core` having been built first —
// `packages/db` itself has no dependency on `@social/core` (persistence
// and crypto/adapters stay decoupled, see src/tokens.ts).
import { decrypt, encrypt } from "../../core/src/crypto.js";
import { createPrismaClient } from "../src/client.js";
import { getAccountForPlatform, getAccountToken, toPrismaPlatform } from "../src/tokens.js";
import { testDatabaseUrl } from "./setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.oAuthToken.deleteMany();
  await prisma.account.deleteMany();
});

describe("toPrismaPlatform", () => {
  it("upper-cases a lowercase platform id", () => {
    expect(toPrismaPlatform("instagram")).toBe("INSTAGRAM");
  });
});

describe("getAccountToken / getAccountForPlatform", () => {
  it("round-trips an AES-256-GCM encrypted access token stored in the database", async () => {
    const account = await prisma.account.create({
      data: {
        platform: "LINKEDIN",
        displayName: "Test account",
        externalId: "ext-1",
        token: { create: { encryptedAccessToken: encrypt("super-secret-token") } },
      },
      include: { token: true },
    });

    const byId = await getAccountToken(prisma, account.id);
    expect(byId?.token?.encryptedAccessToken).not.toBe("super-secret-token");
    expect(decrypt(byId!.token!.encryptedAccessToken)).toBe("super-secret-token");

    const byPlatform = await getAccountForPlatform(prisma, "LINKEDIN");
    expect(byPlatform?.id).toBe(account.id);
    expect(decrypt(byPlatform!.token!.encryptedAccessToken)).toBe("super-secret-token");
  });

  it("returns null for an account with no token", async () => {
    const account = await prisma.account.create({
      data: { platform: "STRAVA", displayName: "No token yet", externalId: "ext-2" },
    });

    expect((await getAccountToken(prisma, account.id))?.token).toBeNull();
    expect(await getAccountForPlatform(prisma, "STRAVA")).toBeNull();
  });

  it("returns null when no account exists for the id or platform", async () => {
    expect(await getAccountToken(prisma, "does-not-exist")).toBeNull();
    expect(await getAccountForPlatform(prisma, "TIKTOK")).toBeNull();
  });

  it("returns the most recently updated account when several exist for a platform", async () => {
    await prisma.account.create({
      data: { platform: "YOUTUBE", displayName: "Old", externalId: "old", token: { create: { encryptedAccessToken: encrypt("old-token") } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await prisma.account.create({
      data: { platform: "YOUTUBE", displayName: "New", externalId: "new", token: { create: { encryptedAccessToken: encrypt("new-token") } } },
    });

    const resolved = await getAccountForPlatform(prisma, "YOUTUBE");
    expect(resolved?.id).toBe(newer.id);
  });
});
