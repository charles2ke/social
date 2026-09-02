import { describe, expect, it, vi } from "vitest";
import type { TokenSet } from "@social/core";
import { authorizedToken, createMemoryAccountRepository } from "../src/accounts.js";

const profile = { id: "acct-1", name: "Demo" };

describe("account repository", () => {
  it("stores a connected account with its platform id", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at" });
    expect(await repository.findByPlatform("linkedin")).toEqual(account);
    expect((await repository.readToken(account.id))?.externalId).toBe("acct-1");
    expect(await repository.list()).toHaveLength(1);
  });
});

describe("authorizedToken", () => {
  it("returns a valid token without refreshing", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at", expiresAt: new Date(Date.now() + 3_600_000) });
    const refresh = vi.fn();
    await expect(authorizedToken(repository, account, refresh)).resolves.toMatchObject({ accessToken: "at" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes and persists an expiring token", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "old", refreshToken: "rt", expiresAt: new Date(Date.now() + 1_000) });
    const refreshed: TokenSet = { accessToken: "new", refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000), externalId: "acct-1" };
    await expect(authorizedToken(repository, account, async () => refreshed)).resolves.toBe(refreshed);
    expect(await repository.readToken(account.id)).toEqual(refreshed);
  });

  it("fails clearly when no token is stored", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at" });
    await expect(authorizedToken({ ...repository, readToken: async () => undefined }, account, async (t) => t)).rejects.toThrow(/No stored token/);
  });
});
