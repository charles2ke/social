import type { Platform, Post, PrismaClient } from "@prisma/client";

/** Default lease length: how long a claim stays valid before a reaper may take it back. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 5 * 60_000;
/** Base delay for the exponential backoff applied between publish attempts. */
export const DEFAULT_RETRY_BACKOFF_MS = 60_000;

/** `base * 2^(attempt - 1)`, capped so a long-failing post still retries daily. */
export function backoffDelayMs(attempt: number, base = DEFAULT_RETRY_BACKOFF_MS): number {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 24 * 60 * 60_000);
}

/**
 * Claims up to `limit` due posts for `workerId` using
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside a single transaction.
 *
 * This is the core reliability mechanism that lets multiple scheduler
 * worker instances poll the same `posts` table concurrently without
 * double-publishing: each worker's transaction only ever sees rows that no
 * other in-flight transaction currently holds a row lock on, so two workers
 * racing for the same due post can never both claim it.
 *
 * The row is marked PUBLISHING (with claimedBy/claimedAt and a lease deadline
 * in claimExpiresAt) and returned in the same transaction, so the claim is
 * durable as soon as this function resolves. A worker that dies before
 * finishing leaves the lease to expire, and `releaseStaleClaims` requeues it.
 */
export async function claimDuePosts(
  prisma: PrismaClient,
  workerId: string,
  options: { limit?: number; now?: Date; claimTimeoutMs?: number } = {},
): Promise<Post[]> {
  const limit = options.limit ?? 1;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS));

  return prisma.$transaction(
    async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM posts
      WHERE status = 'SCHEDULED'
        AND scheduled_for <= ${now}
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY scheduled_for ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

      if (candidates.length === 0) {
        return [];
      }

      const ids = candidates.map((row) => row.id);

      await tx.post.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "PUBLISHING",
          claimedBy: workerId,
          claimedAt: now,
          claimExpiresAt: expiresAt,
          attemptCount: { increment: 1 },
        },
      });

      return tx.post.findMany({
        where: { id: { in: ids } },
        orderBy: { scheduledFor: "asc" },
      });
    },
    {
      isolationLevel: "ReadCommitted",
    },
  );
}

const LEASE_EXPIRED = "Worker lease expired before the post was published";

/**
 * Returns posts whose claim lease expired (their worker crashed or was killed
 * mid-publish) to the queue, or gives up on them once they have used up
 * `maxAttempts`. Run this on every worker tick: without it a single crashed
 * worker would strand its claimed posts in PUBLISHING forever.
 */
export async function releaseStaleClaims(
  prisma: PrismaClient,
  options: { now?: Date } = {},
): Promise<{ requeued: number; failed: number }> {
  const now = options.now ?? new Date();
  const stale = await prisma.post.findMany({
    where: { status: "PUBLISHING", claimExpiresAt: { lte: now } },
    select: { id: true, attemptCount: true, maxAttempts: true },
  });

  let requeued = 0;
  let failed = 0;
  for (const post of stale) {
    const exhausted = post.attemptCount >= post.maxAttempts;
    await prisma.post.update({
      where: { id: post.id },
      data: exhausted
        ? { status: "FAILED", claimedBy: null, claimExpiresAt: null, lastError: LEASE_EXPIRED }
        : {
            status: "SCHEDULED",
            claimedBy: null,
            claimExpiresAt: null,
            nextAttemptAt: new Date(now.getTime() + backoffDelayMs(post.attemptCount)),
            lastError: LEASE_EXPIRED,
          },
    });
    if (exhausted) failed += 1;
    else requeued += 1;
  }
  return { requeued, failed };
}

/**
 * Marks a claimed post's outcome after a publish attempt. Intended to be
 * called by the scheduler once the platform adapters have run.
 */
export async function completePost(
  prisma: PrismaClient,
  postId: string,
  status: "PUBLISHED" | "FAILED",
): Promise<Post> {
  return prisma.post.update({
    where: { id: postId },
    data: {
      status,
      claimExpiresAt: null,
      nextAttemptAt: null,
      ...(status === "PUBLISHED" ? { lastError: null } : {}),
    },
  });
}

/**
 * Records a failed attempt: reschedules the post with exponential backoff
 * while attempts remain, and marks it FAILED once they are exhausted.
 */
export async function failPost(
  prisma: PrismaClient,
  postId: string,
  error: string,
  options: { now?: Date; backoffMs?: number } = {},
): Promise<Post> {
  const now = options.now ?? new Date();
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
    select: { attemptCount: true, maxAttempts: true },
  });
  if (post.attemptCount >= post.maxAttempts) {
    return prisma.post.update({
      where: { id: postId },
      data: { status: "FAILED", claimedBy: null, claimExpiresAt: null, lastError: error },
    });
  }
  return prisma.post.update({
    where: { id: postId },
    data: {
      status: "SCHEDULED",
      claimedBy: null,
      claimExpiresAt: null,
      lastError: error,
      nextAttemptAt: new Date(now.getTime() + backoffDelayMs(post.attemptCount, options.backoffMs)),
    },
  });
}

/**
 * Upserts the per-platform outcome of a publish attempt. The unique
 * (post_id, platform) key makes this idempotent: a retried post updates its
 * existing row instead of appending a duplicate attempt.
 */
export async function recordAttempt(
  prisma: PrismaClient,
  attempt: {
    postId: string;
    platform: Platform;
    accountId?: string | null;
    status: "PENDING" | "SUCCESS" | "FAILED";
    externalPostId?: string | null;
    error?: string | null;
    completedAt?: Date | null;
  },
): Promise<void> {
  const data = {
    accountId: attempt.accountId ?? null,
    status: attempt.status,
    externalPostId: attempt.externalPostId ?? null,
    error: attempt.error ?? null,
    completedAt: attempt.completedAt ?? null,
  };
  await prisma.platformPublishAttempt.upsert({
    where: { postId_platform: { postId: attempt.postId, platform: attempt.platform } },
    create: { postId: attempt.postId, platform: attempt.platform, ...data },
    update: data,
  });
}

/** Platforms of a post that have not been published yet — a retry only re-sends these. */
export async function pendingPlatforms(
  prisma: PrismaClient,
  postId: string,
  platforms: Platform[],
): Promise<Platform[]> {
  const published = await prisma.platformPublishAttempt.findMany({
    where: { postId, status: "SUCCESS" },
    select: { platform: true },
  });
  const done = new Set(published.map((row) => row.platform));
  return platforms.filter((platform) => !done.has(platform));
}
