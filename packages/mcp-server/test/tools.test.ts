import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "@social/core";
import { getPrismaClient } from "@social/db";
import { createServer } from "../src/server.js";

const prisma = getPrismaClient();

const originalMockMode = process.env.MOCK_MODE;
const originalAccessToken = process.env.SOCIAL_ACCESS_TOKEN;

async function connectedClient() {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

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

describe("list_accounts / get_account_status", () => {
  it("returns real connected accounts from the database instead of a hardcoded stub", async () => {
    const account = await prisma.account.create({
      data: {
        platform: "INSTAGRAM",
        displayName: "Test Instagram",
        externalId: "ext-1",
        token: { create: { encryptedAccessToken: encrypt("secret-token") } },
      },
    });

    const client = await connectedClient();
    const list = parse(await client.callTool({ name: "list_accounts", arguments: {} }));
    expect(list).toEqual([expect.objectContaining({ id: account.id, platform: "instagram" })]);

    const status = parse(await client.callTool({ name: "get_account_status", arguments: { accountId: account.id } }));
    expect(status).toMatchObject({ accountId: account.id, connected: true });

    const missing = parse(await client.callTool({ name: "get_account_status", arguments: { accountId: "does-not-exist" } }));
    expect(missing).toMatchObject({ connected: false });
  });
});

describe("publish_post", () => {
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

    const client = await connectedClient();
    const result = parse(await client.callTool({ name: "publish_post", arguments: { text: "hello", platforms: ["linkedin"] } }));
    expect(result).not.toMatchObject({ error: expect.anything() });

    const attempts = await prisma.platformPublishAttempt.findMany({ where: { accountId: account.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("SUCCESS");
  });

  it("rejects publishing when no account is connected and MOCK_MODE=false, ignoring a leftover SOCIAL_ACCESS_TOKEN", async () => {
    process.env.MOCK_MODE = "false";
    process.env.SOCIAL_ACCESS_TOKEN = "leftover-global-token-should-never-be-used";

    const client = await connectedClient();
    const result = parse(await client.callTool({ name: "publish_post", arguments: { text: "hello", platforms: ["linkedin"] } }));
    expect(result.error).toContain("linkedin");
  });
});
