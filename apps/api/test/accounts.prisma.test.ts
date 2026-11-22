import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "@social/db";
import { createPrismaAccountRepository } from "../src/accounts.js";
import { testDatabaseUrl } from "../../../packages/db/test/setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
const profile = { id: "acct-1", name: "Demo" };

beforeEach(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.post.deleteMany();
  await prisma.account.deleteMany();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("Postgres account repository", () => {
  it("disconnects by deleting the tokens but keeps the account's publish history", async () => {
    const accounts = await createPrismaAccountRepository({ prisma });
    const account = await accounts.connect("linkedin", profile, { accessToken: "at", refreshToken: "rt" });
    const post = await prisma.post.create({ data: { content: "hi", platforms: ["LINKEDIN"], status: "PUBLISHED" } });
    await prisma.platformPublishAttempt.create({ data: { postId: post.id, platform: "LINKEDIN", accountId: account.id, status: "SUCCESS" } });

    expect(await accounts.disconnect(account.id)).toMatchObject({ id: account.id, platform: "linkedin" });
    // A refresh that was in flight when the account was disconnected must not restore its tokens.
    await accounts.writeToken(account.id, { accessToken: "refreshed" });

    expect(await accounts.list()).toEqual([]);
    expect(await accounts.findByPlatform("linkedin")).toBeUndefined();
    expect(await prisma.oAuthToken.count()).toBe(0);
    expect(await prisma.platformPublishAttempt.count({ where: { accountId: account.id } })).toBe(1);
    expect(await accounts.disconnect(account.id)).toBeUndefined();

    const reconnected = await accounts.connect("linkedin", profile, { accessToken: "again" });
    expect(reconnected.id).toBe(account.id);
    expect((await accounts.readToken(account.id))?.accessToken).toBe("again");
  });
});
