import type { Account, OAuthToken, Post } from "@social/db";
import { encrypt, type PlatformId, type PostDraft } from "@social/core";
import { getPrismaClient, toPrismaPlatform } from "@social/db";

export type Draft = PostDraft & { id: string; createdAt: string };
export type AccountSummary = {
  id: string;
  platform: PlatformId;
  name: string;
  tokenExpiresAt?: string;
};

const prisma = getPrismaClient();

function toDraft(post: Post): Draft {
  return {
    id: post.id,
    text: post.content,
    mediaUrls: (post.mediaUrls as string[] | null) ?? undefined,
    perPlatformOverrides:
      (post.platformOverrides as Record<string, Partial<PostDraft>> | null) ??
      undefined,
    createdAt: post.createdAt.toISOString(),
  };
}

function toAccountSummary(
  account: Account & { token: OAuthToken | null },
): AccountSummary {
  return {
    id: account.id,
    platform: account.platform.toLowerCase() as PlatformId,
    name: account.displayName,
    tokenExpiresAt: account.token?.expiresAt?.toISOString(),
  };
}

/** Demo accounts seeded for `MOCK_MODE=true` so the dashboard has data to
 * show with no OAuth apps configured. Their tokens are still real
 * AES-256-GCM ciphertext (decryptable with `ENCRYPTION_KEY`), exercising
 * the exact same per-account lookup path used in production. */
const MOCK_PLATFORMS: PlatformId[] = ["instagram", "linkedin"];

export const store = {
  async accounts(): Promise<AccountSummary[]> {
    const accounts = await prisma.account.findMany({
      include: { token: true },
      orderBy: { updatedAt: "desc" },
    });
    return accounts.map(toAccountSummary);
  },
  async addMockAccounts(): Promise<AccountSummary[]> {
    if (process.env.MOCK_MODE === "true") {
      const count = await prisma.account.count();
      if (count === 0) {
        for (const platform of MOCK_PLATFORMS) {
          await prisma.account.create({
            data: {
              platform: toPrismaPlatform(platform),
              displayName: `Demo ${platform}`,
              externalId: `demo-${platform}`,
              token: {
                create: {
                  encryptedAccessToken: encrypt(`mock-${platform}-token`),
                  expiresAt: new Date(Date.now() + 86_400_000),
                },
              },
            },
          });
        }
      }
    }
    return this.accounts();
  },
  async createDraft(draft: PostDraft): Promise<Draft> {
    const post = await prisma.post.create({
      data: {
        content: draft.text,
        mediaUrls: draft.mediaUrls ?? undefined,
        platformOverrides: draft.perPlatformOverrides ?? undefined,
      },
    });
    return toDraft(post);
  },
  async updateDraft(
    id: string,
    draft: Partial<PostDraft>,
  ): Promise<Draft | undefined> {
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing || existing.status !== "DRAFT") return undefined;
    const post = await prisma.post.update({
      where: { id },
      data: {
        content: draft.text ?? undefined,
        mediaUrls: draft.mediaUrls ?? undefined,
      },
    });
    return toDraft(post);
  },
  async drafts(): Promise<Draft[]> {
    const posts = await prisma.post.findMany({
      where: { status: "DRAFT" },
      orderBy: { createdAt: "desc" },
    });
    return posts.map(toDraft);
  },
};
