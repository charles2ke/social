import { randomUUID } from "node:crypto";
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
  options: { limit?: number; now?: Date; claimTimeoutMs?: number; claimToken?: string } = {},
): Promise<Post[]> {
  const limit = options.limit ?? 1;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS));
  const claimToken = options.claimToken ?? randomUUID();

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
          claimToken,
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
 * Extends the lease of a claim that is still being worked on. The worker calls
 * this while it waits on slow platform calls so a live claim is never mistaken
 * for an abandoned one. It is conditional on the claim token, so a worker whose
 * lease was already reaped cannot take the post back from its new owner —
 * `false` tells the caller to stop publishing.
 */
export async function renewClaim(
  prisma: PrismaClient,
  postId: string,
  claimToken: string,
  options: { now?: Date; claimTimeoutMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: "PUBLISHING", claimToken },
    data: { claimExpiresAt: new Date(now.getTime() + (options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS)) },
  });
  return count === 1;
}

/**
 * Returns posts whose claim lease expired (their worker crashed or was killed
 * mid-publish) to the queue, or gives up on them once they have used up
 * `maxAttempts`. Run this on every worker tick: without it a single crashed
 * worker would strand its claimed posts in PUBLISHING forever.
 *
 * Requeuing clears the claim token, which is what stops a merely slow (rather
 * than dead) worker from later completing or failing the post it lost.
 */
export async function releaseStaleClaims(
  prisma: PrismaClient,
  options: { now?: Date } = {},
): Promise<{ requeued: number; failed: number }> {
  const now = options.now ?? new Date();
  const stale = await prisma.post.findMany({
    where: { status: "PUBLISHING", claimExpiresAt: { lte: now } },
    select: { id: true, attemptCount: true, maxAttempts: true, claimToken: true },
  });

  let requeued = 0;
  let failed = 0;
  for (const post of stale) {
    const exhausted = post.attemptCount >= post.maxAttempts;
    const { count } = await prisma.post.updateMany({
      where: { id: post.id, status: "PUBLISHING", claimToken: post.claimToken, claimExpiresAt: { lte: now } },
      data: exhausted
        ? { status: "FAILED", claimedBy: null, claimExpiresAt: null, claimToken: null, lastError: LEASE_EXPIRED }
        : {
            status: "SCHEDULED",
            claimedBy: null,
            claimExpiresAt: null,
            claimToken: null,
            nextAttemptAt: new Date(now.getTime() + backoffDelayMs(post.attemptCount)),
            lastError: LEASE_EXPIRED,
          },
    });
    if (!count) continue;
    if (exhausted) failed += 1;
    else requeued += 1;
  }
  return { requeued, failed };
}

/**
 * Marks a claimed post's outcome after a publish attempt. The update is
 * conditional on the post still being PUBLISHING under the caller's claim
 * token, so a worker whose lease was reaped cannot overwrite the newer claim;
 * `null` is returned when the claim was lost.
 */
export async function completePost(
  prisma: PrismaClient,
  postId: string,
  status: "PUBLISHED" | "FAILED",
  options: { claimToken?: string } = {},
): Promise<Post | null> {
  const where = { id: postId, status: "PUBLISHING" as const, ...(options.claimToken ? { claimToken: options.claimToken } : {}) };
  const { count } = await prisma.post.updateMany({
    where,
    data: {
      status,
      claimExpiresAt: null,
      claimToken: null,
      nextAttemptAt: null,
      ...(status === "PUBLISHED" ? { lastError: null } : {}),
    },
  });
  return count ? prisma.post.findUnique({ where: { id: postId } }) : null;
}

/**
 * Records a failed attempt: reschedules the post with exponential backoff
 * while attempts remain, and marks it FAILED once they are exhausted.
 *
 * The attempt count is read and the row updated in one transaction, both
 * conditional on the caller's claim, so a delayed worker cannot reschedule a
 * post that has already been reclaimed by another worker.
 */
export async function failPost(
  prisma: PrismaClient,
  postId: string,
  error: string,
  options: { now?: Date; backoffMs?: number; claimToken?: string } = {},
): Promise<Post | null> {
  const now = options.now ?? new Date();
  const where = { id: postId, status: "PUBLISHING" as const, ...(options.claimToken ? { claimToken: options.claimToken } : {}) };
  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findFirst({ where, select: { attemptCount: true, maxAttempts: true } });
    if (!post) return null;
    const exhausted = post.attemptCount >= post.maxAttempts;
    const { count } = await tx.post.updateMany({
      where,
      data: exhausted
        ? { status: "FAILED", claimedBy: null, claimExpiresAt: null, claimToken: null, lastError: error }
        : {
            status: "SCHEDULED",
            claimedBy: null,
            claimExpiresAt: null,
            claimToken: null,
            lastError: error,
            nextAttemptAt: new Date(now.getTime() + backoffDelayMs(post.attemptCount, options.backoffMs)),
          },
    });
    return count ? tx.post.findUnique({ where: { id: postId } }) : null;
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

/**
 * Splits a post's target platforms into the ones a retry may publish and the
 * ones whose outcome is unknown.
 *
 * A PENDING attempt row was written immediately before the provider call, so
 * it means the process died in the window where the platform may already have
 * accepted the post. Republishing would risk a duplicate external post, so
 * those platforms are reported separately for reconciliation instead.
 */
export async function publishTargets(
  prisma: PrismaClient,
  postId: string,
  platforms: Platform[],
): Promise<{ pending: Platform[]; unconfirmed: Platform[] }> {
  const attempts = await prisma.platformPublishAttempt.findMany({
    where: { postId },
    select: { platform: true, status: true },
  });
  const status = new Map(attempts.map((attempt) => [attempt.platform, attempt.status]));
  const pending: Platform[] = [];
  const unconfirmed: Platform[] = [];
  for (const platform of platforms) {
    const recorded = status.get(platform);
    if (recorded === "SUCCESS") continue;
    if (recorded === "PENDING") unconfirmed.push(platform);
    else pending.push(platform);
  }
  return { pending, unconfirmed };
}
