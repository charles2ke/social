import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/client.js";
import { claimDuePosts, completePost } from "../src/scheduler.js";
import { testDatabaseUrl } from "./setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.analyticsSnapshot.deleteMany();
  await prisma.post.deleteMany();
  await prisma.oAuthToken.deleteMany();
  await prisma.account.deleteMany();
});

async function createDuePost() {
  return prisma.post.create({
    data: {
      content: "hello world",
      status: "SCHEDULED",
      scheduledFor: new Date(Date.now() - 1000),
    },
  });
}

describe("claimDuePosts", () => {
  it("claims a due post and marks it PUBLISHING", async () => {
    const post = await createDuePost();

    const [claimed] = await claimDuePosts(prisma, "worker-a", { limit: 1 });

    expect(claimed.id).toBe(post.id);
    expect(claimed.status).toBe("PUBLISHING");
    expect(claimed.claimedBy).toBe("worker-a");
  });

  it("does not reclaim a post that is not SCHEDULED", async () => {
    await prisma.post.create({
      data: { content: "draft post", status: "DRAFT" },
    });

    const claimed = await claimDuePosts(prisma, "worker-a", { limit: 5 });

    expect(claimed).toHaveLength(0);
  });

  it("does not claim posts scheduled in the future", async () => {
    await prisma.post.create({
      data: {
        content: "future post",
        status: "SCHEDULED",
        scheduledFor: new Date(Date.now() + 60_000),
      },
    });

    const claimed = await claimDuePosts(prisma, "worker-a", { limit: 5 });

    expect(claimed).toHaveLength(0);
  });

  it(
    "exactly one of two concurrent workers claims the same due post",
    async () => {
      const post = await createDuePost();

      // Two independent Prisma clients (and thus separate DB connections /
      // transactions) racing for the same row — this is the scenario
      // `SELECT ... FOR UPDATE SKIP LOCKED` exists to make safe.
      const workerA = createPrismaClient({ databaseUrl: testDatabaseUrl() });
      const workerB = createPrismaClient({ databaseUrl: testDatabaseUrl() });

      try {
        const [resultA, resultB] = await Promise.all([
          claimDuePosts(workerA, "worker-a", { limit: 1 }),
          claimDuePosts(workerB, "worker-b", { limit: 1 }),
        ]);

        const claims = [...resultA, ...resultB];
        expect(claims).toHaveLength(1);
        expect(claims[0]?.id).toBe(post.id);

        const claimingWorker = resultA.length === 1 ? "worker-a" : "worker-b";
        expect(claims[0]?.claimedBy).toBe(claimingWorker);

        const finalPost = await prisma.post.findUniqueOrThrow({
          where: { id: post.id },
        });
        expect(finalPost.status).toBe("PUBLISHING");
        expect(finalPost.claimedBy).toBe(claimingWorker);

        await completePost(prisma, post.id, "PUBLISHED");
        const publishedPost = await prisma.post.findUniqueOrThrow({
          where: { id: post.id },
        });
        expect(publishedPost.status).toBe("PUBLISHED");
      } finally {
        await workerA.$disconnect();
        await workerB.$disconnect();
      }
    },
  );

  it("respects limit and claims the earliest-due posts first", async () => {
    const older = await prisma.post.create({
      data: {
        content: "older",
        status: "SCHEDULED",
        scheduledFor: new Date(Date.now() - 5000),
      },
    });
    await prisma.post.create({
      data: {
        content: "newer",
        status: "SCHEDULED",
        scheduledFor: new Date(Date.now() - 1000),
      },
    });

    const claimed = await claimDuePosts(prisma, "worker-a", { limit: 1 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(older.id);
  });
});
