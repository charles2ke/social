import { randomUUID } from "node:crypto";
import { decrypt, encrypt, isExpired, type PlatformId, type Profile, type TokenSet } from "@social/core";
import { stringEnv } from "./env.js";

export type ConnectedAccount = {
  id: string;
  platform: PlatformId;
  name: string;
  externalId: string;
  tokenExpiresAt?: string;
};

type StoredToken = { token: TokenSet; revision: string };

export interface AccountRepository {
  list(): Promise<ConnectedAccount[]>;
  findByPlatform(platform: PlatformId): Promise<ConnectedAccount | undefined>;
  connect(platform: PlatformId, profile: Profile, token: TokenSet): Promise<ConnectedAccount>;
  readToken(accountId: string): Promise<StoredToken | undefined>;
  /** Replaces tokens only if the connection has not changed since they were read. */
  writeToken(accountId: string, token: TokenSet, revision: string): Promise<void>;
  /** Deletes the account's stored tokens; returns the account, or undefined when it is not connected. */
  disconnect(accountId: string): Promise<ConnectedAccount | undefined>;
}

/** Used when no DATABASE_URL is configured (e.g. the mock-mode demo). */
export function createMemoryAccountRepository(): AccountRepository {
  const accounts = new Map<string, ConnectedAccount>();
  const tokens = new Map<string, StoredToken>();
  return {
    async list() {
      return [...accounts.values()];
    },
    async findByPlatform(platform) {
      return [...accounts.values()].find((account) => account.platform === platform);
    },
    async connect(platform, profile, token) {
      const id = `${platform}:${profile.id}`;
      const account: ConnectedAccount = {
        id,
        platform,
        name: profile.name,
        externalId: profile.id,
        tokenExpiresAt: token.expiresAt?.toISOString(),
      };
      accounts.set(id, account);
      tokens.set(id, { token: { ...token, externalId: token.externalId ?? profile.id }, revision: randomUUID() });
      return account;
    },
    async readToken(accountId) {
      return tokens.get(accountId);
    },
    async writeToken(accountId, token, revision) {
      const account = accounts.get(accountId);
      if (!account || tokens.get(accountId)?.revision !== revision) return;
      tokens.set(accountId, { token, revision: randomUUID() });
      accounts.set(accountId, { ...account, tokenExpiresAt: token.expiresAt?.toISOString() });
    },
    async disconnect(accountId) {
      const account = accounts.get(accountId);
      accounts.delete(accountId);
      tokens.delete(accountId);
      return account;
    },
  };
}

type PrismaModule = typeof import("@social/db");
type PrismaClient = ReturnType<PrismaModule["getPrismaClient"]>;

const toEnum = (platform: PlatformId) => platform.toUpperCase() as Uppercase<PlatformId>;
const toPlatformId = (value: string) => value.toLowerCase() as PlatformId;

/**
 * Postgres-backed accounts. Access and refresh tokens are AES-256-GCM
 * encrypted by the application layer before they are written, so the database
 * never stores plaintext credentials (see docs/adr/0001-database.md).
 *
 * Disconnecting deletes the tokens but keeps the account row, because publish
 * attempts reference it: deleting it would cascade away the per-platform
 * publish history that stops a retry from posting twice. An account counts
 * as connected while it has tokens; reconnecting it restores them.
 */
export async function createPrismaAccountRepository(options: { prisma?: PrismaClient } = {}): Promise<AccountRepository> {
  const { getPrismaClient }: PrismaModule = await import("@social/db");
  const prisma = options.prisma ?? getPrismaClient();

  const toAccount = (row: { id: string; platform: string; displayName: string; externalId: string; token?: { expiresAt: Date | null } | null }): ConnectedAccount => ({
    id: row.id,
    platform: toPlatformId(row.platform),
    name: row.displayName,
    externalId: row.externalId,
    tokenExpiresAt: row.token?.expiresAt?.toISOString(),
  });

  const connected = { token: { isNot: null } };

  return {
    async list() {
      const rows = await prisma.account.findMany({ where: connected, include: { token: true }, orderBy: { createdAt: "asc" } });
      return rows.map(toAccount);
    },
    async findByPlatform(platform) {
      const row = await prisma.account.findFirst({
        where: { platform: toEnum(platform), ...connected },
        include: { token: true },
        orderBy: { createdAt: "asc" },
      });
      return row ? toAccount(row) : undefined;
    },
    async connect(platform, profile, token) {
      const encrypted = {
        encryptedAccessToken: encrypt(token.accessToken),
        encryptedRefreshToken: token.refreshToken ? encrypt(token.refreshToken) : null,
        expiresAt: token.expiresAt ?? null,
      };
      const row = await prisma.account.upsert({
        where: { platform_externalId: { platform: toEnum(platform), externalId: profile.id } },
        create: {
          platform: toEnum(platform),
          externalId: profile.id,
          displayName: profile.name,
          token: { create: encrypted },
        },
        update: {
          displayName: profile.name,
          token: { upsert: { create: encrypted, update: encrypted } },
        },
        include: { token: true },
      });
      return toAccount(row);
    },
    async readToken(accountId) {
      const row = await prisma.oAuthToken.findUnique({ where: { accountId }, include: { account: true } });
      if (!row) return undefined;
      return {
        token: {
          accessToken: decrypt(row.encryptedAccessToken),
          refreshToken: row.encryptedRefreshToken ? decrypt(row.encryptedRefreshToken) : undefined,
          expiresAt: row.expiresAt ?? undefined,
          externalId: row.account.externalId,
        },
        revision: row.encryptedAccessToken,
      };
    },
    async writeToken(accountId, token, revision) {
      const encrypted = {
        encryptedAccessToken: encrypt(token.accessToken),
        encryptedRefreshToken: token.refreshToken ? encrypt(token.refreshToken) : null,
        expiresAt: token.expiresAt ?? null,
      };
      // Only ever an UPDATE of an existing row: that is all the least-privilege
      // worker role may do on oauth_tokens (see the social_worker_grants
      // migration). The ciphertext changes on every connect or refresh, so it
      // also guards against a disconnect/reconnect or a competing refresh.
      await prisma.oAuthToken.updateMany({ where: { accountId, encryptedAccessToken: revision }, data: encrypted });
    },
    async disconnect(accountId) {
      const row = await prisma.account.findFirst({ where: { id: accountId, ...connected } });
      if (!row) return undefined;
      const { count } = await prisma.oAuthToken.deleteMany({ where: { accountId } });
      return count ? toAccount({ ...row, token: null }) : undefined;
    },
  };
}

export async function createAccountRepository(): Promise<AccountRepository> {
  if (stringEnv(process.env, "DATABASE_URL")) return createPrismaAccountRepository();
  if (process.env.MOCK_MODE !== "true") {
    console.warn("DATABASE_URL is not set — connected accounts and tokens will only live in memory");
  }
  return createMemoryAccountRepository();
}

/**
 * Returns a usable access token for the account, refreshing and persisting it
 * first when it is at (or near) expiry.
 */
export async function authorizedToken(
  repository: AccountRepository,
  account: ConnectedAccount,
  refresh: (token: TokenSet) => Promise<TokenSet>,
): Promise<TokenSet> {
  const stored = await repository.readToken(account.id);
  if (!stored) throw new Error(`No stored token for the connected ${account.platform} account`);
  const { token, revision } = stored;
  if (!isExpired(token)) return token;
  const refreshed = await refresh(token);
  if (refreshed.accessToken !== token.accessToken || refreshed.expiresAt !== token.expiresAt) {
    await repository.writeToken(account.id, refreshed, revision);
  }
  return refreshed;
}
