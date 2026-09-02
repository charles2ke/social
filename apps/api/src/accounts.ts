import { decrypt, encrypt, isExpired, type PlatformId, type Profile, type TokenSet } from "@social/core";

export type ConnectedAccount = {
  id: string;
  platform: PlatformId;
  name: string;
  externalId: string;
  tokenExpiresAt?: string;
};

export interface AccountRepository {
  list(): Promise<ConnectedAccount[]>;
  findByPlatform(platform: PlatformId): Promise<ConnectedAccount | undefined>;
  connect(platform: PlatformId, profile: Profile, token: TokenSet): Promise<ConnectedAccount>;
  readToken(accountId: string): Promise<TokenSet | undefined>;
  writeToken(accountId: string, token: TokenSet): Promise<void>;
}

/** Used when no DATABASE_URL is configured (e.g. the mock-mode demo). */
export function createMemoryAccountRepository(): AccountRepository {
  const accounts = new Map<string, ConnectedAccount>();
  const tokens = new Map<string, TokenSet>();
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
      tokens.set(id, { ...token, externalId: token.externalId ?? profile.id });
      return account;
    },
    async readToken(accountId) {
      return tokens.get(accountId);
    },
    async writeToken(accountId, token) {
      tokens.set(accountId, token);
      const account = accounts.get(accountId);
      if (account) accounts.set(accountId, { ...account, tokenExpiresAt: token.expiresAt?.toISOString() });
    },
  };
}

type PrismaModule = typeof import("@social/db");

const toEnum = (platform: PlatformId) => platform.toUpperCase() as Uppercase<PlatformId>;
const toPlatformId = (value: string) => value.toLowerCase() as PlatformId;

/**
 * Postgres-backed accounts. Access and refresh tokens are AES-256-GCM
 * encrypted by the application layer before they are written, so the database
 * never stores plaintext credentials (see docs/adr/0001-database.md).
 */
export async function createPrismaAccountRepository(): Promise<AccountRepository> {
  const { getPrismaClient }: PrismaModule = await import("@social/db");
  const prisma = getPrismaClient();

  const toAccount = (row: { id: string; platform: string; displayName: string; externalId: string; token?: { expiresAt: Date | null } | null }): ConnectedAccount => ({
    id: row.id,
    platform: toPlatformId(row.platform),
    name: row.displayName,
    externalId: row.externalId,
    tokenExpiresAt: row.token?.expiresAt?.toISOString(),
  });

  return {
    async list() {
      const rows = await prisma.account.findMany({ include: { token: true }, orderBy: { createdAt: "asc" } });
      return rows.map(toAccount);
    },
    async findByPlatform(platform) {
      const row = await prisma.account.findFirst({
        where: { platform: toEnum(platform) },
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
        accessToken: decrypt(row.encryptedAccessToken),
        refreshToken: row.encryptedRefreshToken ? decrypt(row.encryptedRefreshToken) : undefined,
        expiresAt: row.expiresAt ?? undefined,
        externalId: row.account.externalId,
      };
    },
    async writeToken(accountId, token) {
      const encrypted = {
        encryptedAccessToken: encrypt(token.accessToken),
        encryptedRefreshToken: token.refreshToken ? encrypt(token.refreshToken) : null,
        expiresAt: token.expiresAt ?? null,
      };
      await prisma.oAuthToken.upsert({ where: { accountId }, create: { accountId, ...encrypted }, update: encrypted });
    },
  };
}

export async function createAccountRepository(): Promise<AccountRepository> {
  if (process.env.DATABASE_URL) return createPrismaAccountRepository();
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
  const token = await repository.readToken(account.id);
  if (!token) throw new Error(`No stored token for the connected ${account.platform} account`);
  if (!isExpired(token)) return token;
  const refreshed = await refresh(token);
  if (refreshed.accessToken !== token.accessToken || refreshed.expiresAt !== token.expiresAt) {
    await repository.writeToken(account.id, refreshed);
  }
  return refreshed;
}
