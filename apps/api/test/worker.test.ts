import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "@social/db";
import { runWorkerTick } from "../src/worker.js";
import { testDatabaseUrl } from "../../../packages/db/test/setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.post.deleteMany();
});

const scheduledPost = (overrides: Record<string, unknown> = {}) =>
  prisma.post.create({
    data: {
      content: "ship it",
      status: "SCHEDULED",
      platforms: ["LINKEDIN", "FACEBOOK"],
      scheduledFor: new Date(Date.now() - 1000),
      ...overrides,
    },
  });

const published = async () => ({ platformPostId: "urn:1", publishedAt: new Date() });

describe("runWorkerTick", () => {
  it("publishes a due post to each target platform and marks it PUBLISHED", async () => {
    const post = await scheduledPost();
    const publish = vi.fn(published);

    const result = await runWorkerTick({ prisma, publish, workerId: "worker-a" });

    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(publish.mock.calls.map(([platform]) => platform)).toEqual(["linkedin", "facebook"]);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
    const attempts = await prisma.platformPublishAttempt.findMany({ where: { postId: post.id } });
    expect(attempts.every((attempt) => attempt.status === "SUCCESS")).toBe(true);
  });

  it("leaves nothing to do when no post is due", async () => {
    await scheduledPost({ scheduledFor: new Date(Date.now() + 60_000) });
    const publish = vi.fn(published);

    expect(await runWorkerTick({ prisma, publish })).toMatchObject({ claimed: 0, published: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("requeues the post and records the failure when a platform rejects it", async () => {
    const post = await scheduledPost({ platforms: ["LINKEDIN"] });
    const publish = vi.fn(async () => {
      throw new Error("LinkedIn rejected the share");
    });

    expect(await runWorkerTick({ prisma, publish })).toMatchObject({ claimed: 1, published: 0, failed: 1 });

    const requeued = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(requeued.status).toBe("SCHEDULED");
    expect(requeued.attemptCount).toBe(1);
    expect(requeued.lastError).toContain("LinkedIn rejected the share");
    const [attempt] = await prisma.platformPublishAttempt.findMany({ where: { postId: post.id } });
    expect(attempt?.status).toBe("FAILED");
  });

  it("never re-publishes a platform that already succeeded", async () => {
    const post = await scheduledPost();
    const failFacebook = vi.fn(async (platform: string) => {
      if (platform === "facebook") throw new Error("Facebook is down");
      return { platformPostId: "urn:1", publishedAt: new Date() };
    });

    await runWorkerTick({ prisma, publish: failFacebook });
    // The requeued post is only due again after its backoff, so publish now.
    await prisma.post.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    const retry = vi.fn(published);
    await runWorkerTick({ prisma, publish: retry });

    expect(retry.mock.calls.map(([platform]) => platform)).toEqual(["facebook"]);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
  });

  it("redacts secrets out of the recorded error", async () => {
    const post = await scheduledPost({ platforms: ["LINKEDIN"] });
    const publish = vi.fn(async () => {
      throw new Error('{"access_token":"super-secret-token"}');
    });

    await runWorkerTick({ prisma, publish });

    const [attempt] = await prisma.platformPublishAttempt.findMany({ where: { postId: post.id } });
    expect(attempt?.error).not.toContain("super-secret-token");
  });

  it("does not republish a platform whose previous attempt was interrupted", async () => {
    const post = await scheduledPost({ platforms: ["LINKEDIN"] });
    // A PENDING row is what a crash between the provider call and its outcome
    // leaves behind — the post may already be live on the platform.
    await prisma.platformPublishAttempt.create({ data: { postId: post.id, platform: "LINKEDIN", status: "PENDING" } });
    const publish = vi.fn(published);

    const result = await runWorkerTick({ prisma, publish });

    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/outcome is unknown/i);
  });

  it("fails a post that has no target platforms instead of marking it published", async () => {
    const post = await scheduledPost({ platforms: [] });

    expect(await runWorkerTick({ prisma, publish: vi.fn(published) })).toMatchObject({ published: 0, failed: 1 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/no target platforms/i);
  });

  it("does not complete a post whose lease was reaped mid-publish", async () => {
    const post = await scheduledPost({ platforms: ["LINKEDIN"] });
    const publish = vi.fn(async () => {
      // Another worker reaps the expired lease while this publish is in flight.
      await prisma.post.update({ where: { id: post.id }, data: { status: "SCHEDULED", claimToken: null, claimedBy: null, claimExpiresAt: null } });
      return { platformPostId: "urn:1", publishedAt: new Date() };
    });

    expect(await runWorkerTick({ prisma, publish })).toMatchObject({ claimed: 1, published: 0, failed: 0 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
  });

  it("requeues a lease abandoned by a dead worker", async () => {
    const post = await scheduledPost({ platforms: ["LINKEDIN"], status: "PUBLISHING", claimedBy: "dead", claimExpiresAt: new Date(Date.now() - 1000) });

    const result = await runWorkerTick({ prisma, publish: vi.fn(published) });

    expect(result.requeued).toBe(1);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
  });
});
