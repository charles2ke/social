import { redactSecrets, type MediaAttachment, type PlatformId, type PlatformOverrides, type PostDraft, type PublishResult } from "@social/core";
import { publishTargets, recordAttempt, renewClaim, type Post, type PrismaClient } from "@social/db";

export type PublishFn = (platform: PlatformId, draft: PostDraft) => Promise<PublishResult>;

/** What one publish attempt did on one platform. */
export type PlatformOutcome =
  | { platform: PlatformId; status: "published"; platformPostId: string; url?: string }
  | { platform: PlatformId; status: "failed"; error: string };

export type ClaimedPostOutcome = {
  /** False when the claim was lost mid-publish — the caller must then leave the post alone. */
  leaseHeld: boolean;
  /** Every failure of this attempt, joined into the post's `lastError` by the caller. */
  errors: string[];
  /** One entry per platform this attempt published to or had to skip. */
  results: PlatformOutcome[];
};

const toPlatformId = (value: string) => value.toLowerCase() as PlatformId;

/**
 * Keeps renewing the claim while `work` runs, so a publisher that is merely
 * slow (a platform call can outlive the lease) is not mistaken for a dead one
 * and has its post requeued underneath it.
 */
async function withLeaseHeartbeat<T>(
  prisma: PrismaClient,
  postId: string,
  claimToken: string | undefined,
  claimTimeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!claimToken) return work();
  const heartbeat = setInterval(() => {
    void renewClaim(prisma, postId, claimToken, { claimTimeoutMs }).catch(() => undefined);
  }, Math.max(1_000, Math.floor(claimTimeoutMs / 3)));
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Publishes a post this process has claimed (status PUBLISHING) to each of its
 * platforms, recording one attempt row per platform. Shared by the scheduler
 * worker and the API's publish-now route; the caller settles the post.
 *
 * Only platforms without a recorded SUCCESS are sent, so a retry never
 * double-posts where a previous attempt already succeeded, and a platform
 * whose attempt was interrupted mid-call is left for reconciliation rather
 * than published again.
 */
export async function publishClaimedPost(options: {
  prisma: PrismaClient;
  post: Post;
  publish: PublishFn;
  /** Resolves the connected account id recorded on each attempt row. */
  accountIdFor?: (platform: PlatformId) => Promise<string | undefined>;
  claimTimeoutMs: number;
}): Promise<ClaimedPostOutcome> {
  const { prisma, post, claimTimeoutMs } = options;
  const claimToken = post.claimToken ?? undefined;
  const { pending, unconfirmed } = await publishTargets(prisma, post.id, post.platforms);
  const overrides = post.platformOverrides;
  const draft: PostDraft = {
    id: post.id,
    text: post.content,
    media: Array.isArray(post.mediaUrls) ? (post.mediaUrls as unknown as MediaAttachment[]) : [],
    ...(typeof overrides === "object" && overrides !== null && !Array.isArray(overrides)
      ? { perPlatformOverrides: overrides as PlatformOverrides }
      : {}),
  };

  const errors: string[] = [];
  const results: PlatformOutcome[] = [];
  // A platform whose attempt is still PENDING was interrupted between the
  // provider call and its outcome being stored, so the post may already be
  // live there. Republishing it could duplicate the external post, so it is
  // surfaced for reconciliation instead.
  if (unconfirmed.length) {
    const reason = "previous publish outcome is unknown — reconcile the post on the platform before retrying";
    errors.push(`${unconfirmed.map(toPlatformId).join(", ")}: ${reason}`);
    results.push(...unconfirmed.map((target) => ({ platform: toPlatformId(target), status: "failed" as const, error: reason })));
  }
  if (!post.platforms.length) {
    errors.push("no target platforms — the post cannot be published");
  }

  let leaseHeld = true;
  await withLeaseHeartbeat(prisma, post.id, claimToken, claimTimeoutMs, async () => {
    for (const target of pending) {
      // Renew before each provider call too: losing the lease means another
      // process owns the post now, so this one must stop publishing.
      leaseHeld = claimToken ? await renewClaim(prisma, post.id, claimToken, { claimTimeoutMs }) : true;
      if (!leaseHeld) break;
      const platform = toPlatformId(target);
      const accountId = await options.accountIdFor?.(platform);
      // Recorded before the call so a crash in the publish window leaves a
      // PENDING row rather than looking like an attempt that never happened.
      await recordAttempt(prisma, { postId: post.id, platform: target, accountId: accountId ?? null, status: "PENDING" });
      try {
        const result = await options.publish(platform, draft);
        await recordAttempt(prisma, {
          postId: post.id,
          platform: target,
          accountId: accountId ?? null,
          status: "SUCCESS",
          externalPostId: result.platformPostId,
          completedAt: new Date(),
        });
        results.push({ platform, status: "published", platformPostId: result.platformPostId, ...(result.url ? { url: result.url } : {}) });
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : "Publishing failed");
        errors.push(`${platform}: ${message}`);
        results.push({ platform, status: "failed", error: message });
        await recordAttempt(prisma, {
          postId: post.id,
          platform: target,
          accountId: accountId ?? null,
          status: "FAILED",
          error: message,
          completedAt: new Date(),
        });
      }
    }
  });

  return { leaseHeld, errors, results };
}
