import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "@social/core";
import { getPrismaClient } from "@social/db";
import { buildApp } from "../src/app.js";

const prisma = getPrismaClient();

const originalMockMode = process.env.MOCK_MODE;
const originalAccessToken = process.env.SOCIAL_ACCESS_TOKEN;

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.oAuthToken.deleteMany();
  await prisma.account.deleteMany();
  await prisma.post.deleteMany();
});

afterEach(() => {
  if (originalMockMode === undefined) delete process.env.MOCK_MODE;
  else process.env.MOCK_MODE = originalMockMode;
  if (originalAccessToken === undefined) delete process.env.SOCIAL_ACCESS_TOKEN;
  else process.env.SOCIAL_ACCESS_TOKEN = originalAccessToken;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /publish", () => {
  it("resolves and uses the connected account's decrypted DB token, ignoring a leftover SOCIAL_ACCESS_TOKEN", async () => {
    process.env.MOCK_MODE = "true";
    process.env.SOCIAL_ACCESS_TOKEN = "leftover-global-token-should-never-be-used";
    const account = await prisma.account.create({
      data: {
        platform: "LINKEDIN",
        displayName: "Test LinkedIn",
        externalId: "ext-1",
        token: { create: { encryptedAccessToken: encrypt("real-secret-token") } },
      },
    });

    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/publish", payload: { text: "hello", platforms: ["linkedin"] } });
    expect(response.statusCode).toBe(200);

    const attempts = await prisma.platformPublishAttempt.findMany({ where: { accountId: account.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("SUCCESS");
    await app.close();
  });

  it("falls back to a mock token only when no account is connected and MOCK_MODE=true, without persisting a publish attempt", async () => {
    process.env.MOCK_MODE = "true";
    delete process.env.SOCIAL_ACCESS_TOKEN;

    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/publish", payload: { text: "hello", platforms: ["linkedin"] } });
    expect(response.statusCode).toBe(200);

    const attempts = await prisma.platformPublishAttempt.findMany();
    expect(attempts).toHaveLength(0);
    await app.close();
  });

  it("rejects publishing when no account is connected and MOCK_MODE=false, ignoring a leftover SOCIAL_ACCESS_TOKEN", async () => {
    process.env.MOCK_MODE = "false";
    process.env.SOCIAL_ACCESS_TOKEN = "leftover-global-token-should-never-be-used";

    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/publish", payload: { text: "hello", platforms: ["linkedin"] } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain("linkedin");
    await app.close();
  });
});
