import type { Post, PrismaClient } from "@prisma/client";

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
 * The row is marked PUBLISHING (with claimedBy/claimedAt set) and returned
 * in the same transaction, so the claim is durable as soon as this function
 * resolves.
 */
export async function claimDuePosts(
  prisma: PrismaClient,
  workerId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<Post[]> {
  const limit = options.limit ?? 1;
  const now = options.now ?? new Date();

  return prisma.$transaction(
    async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM posts
      WHERE status = 'SCHEDULED'
        AND scheduled_for <= ${now}
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
        },
      });

      return tx.post.findMany({ where: { id: { in: ids } } });
    },
    {
      isolationLevel: "ReadCommitted",
    },
  );
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
    data: { status },
  });
}
