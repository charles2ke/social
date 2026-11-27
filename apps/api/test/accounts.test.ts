import { describe, expect, it, vi } from "vitest";
import type { TokenSet } from "@social/core";
import { authorizedToken, createMemoryAccountRepository } from "../src/accounts.js";

const profile = { id: "acct-1", name: "Demo" };

describe("account repository", () => {
  it("stores a connected account with its platform id", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at" });
    expect(await repository.findByPlatform("linkedin")).toEqual(account);
    expect((await repository.readToken(account.id))?.token.externalId).toBe("acct-1");
    expect(await repository.list()).toHaveLength(1);
  });

  it("disconnects an account, after which a token refresh cannot bring it back", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at" });
    const stored = await repository.readToken(account.id);
    expect(await repository.disconnect(account.id)).toEqual(account);
    await repository.writeToken(account.id, { accessToken: "refreshed" }, stored!.revision);
    expect(await repository.list()).toEqual([]);
    expect(await repository.findByPlatform("linkedin")).toBeUndefined();
    expect(await repository.readToken(account.id)).toBeUndefined();
    expect(await repository.disconnect(account.id)).toBeUndefined();
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
    expect((await repository.readToken(account.id))?.token).toEqual(refreshed);
  });

  it.each([true, false])("does not overwrite a reconnected account (disconnect first: %s)", async (disconnect) => {
    const repository = createMemoryAccountRepository();
    const original = { accessToken: "old", expiresAt: new Date(0) };
    const account = await repository.connect("linkedin", profile, original);
    await authorizedToken(repository, account, async () => {
      if (disconnect) await repository.disconnect(account.id);
      await repository.connect("linkedin", profile, original);
      return { accessToken: "stale" };
    });
    expect((await repository.readToken(account.id))?.token).toEqual({ ...original, externalId: profile.id });
  });

  it("does not overwrite a newer refresh", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "old", expiresAt: new Date(0) });
    await authorizedToken(repository, account, async () => {
      await authorizedToken(repository, account, async () => ({ accessToken: "newer" }));
      return { accessToken: "stale" };
    });
    expect((await repository.readToken(account.id))?.token.accessToken).toBe("newer");
  });

  it("fails clearly when no token is stored", async () => {
    const repository = createMemoryAccountRepository();
    const account = await repository.connect("linkedin", profile, { accessToken: "at" });
    await expect(authorizedToken({ ...repository, readToken: async () => undefined }, account, async (t) => t)).rejects.toThrow(/No stored token/);
  });
});
