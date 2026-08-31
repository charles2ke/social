import type { Account, OAuthToken, Platform, PrismaClient } from "@prisma/client";

/**
 * Maps a lowercase platform id (e.g. `"instagram"`, as used by
 * `@social/core`'s `PlatformId`) to the uppercase Prisma `Platform` enum
 * value used in the database (e.g. `"INSTAGRAM"`). Both are derived from
 * the same 9-platform list, so this is a pure case conversion, not a
 * lookup table. Typed as `string -> Platform` (rather than importing
 * `PlatformId` from `@social/core`) so this package has no dependency on
 * `@social/core` — persistence and crypto/adapters stay decoupled.
 */
export function toPrismaPlatform(platform: string): Platform {
  return platform.toUpperCase() as Platform;
}

export type AccountWithToken = Account & { token: OAuthToken | null };

/**
 * Looks up a connected account and its (still-encrypted) OAuth token by
 * account id. Returns `null` if the account doesn't exist — "not found" is
 * an expected state here, not an error. Callers are responsible for
 * decrypting `token.encryptedAccessToken` (see `@social/core`'s
 * AES-256-GCM `decrypt`); this package never handles plaintext tokens.
 */
export async function getAccountToken(
  prisma: PrismaClient,
  accountId: string,
): Promise<AccountWithToken | null> {
  return prisma.account.findUnique({
    where: { id: accountId },
    include: { token: true },
  });
}

/**
 * Resolves the most-recently-updated connected account for a platform,
 * including its (still-encrypted) OAuth token. Used where a caller only
 * specifies a platform (not a specific account) — e.g. the
 * single-account-per-platform demo flows in the API and MCP server.
 */
export async function getAccountForPlatform(
  prisma: PrismaClient,
  platform: Platform,
): Promise<AccountWithToken | null> {
  return prisma.account.findFirst({
    where: { platform, token: { isNot: null } },
    include: { token: true },
    orderBy: { updatedAt: "desc" },
  });
}
