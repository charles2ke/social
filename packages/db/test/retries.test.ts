import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/client.js";
import {
  backoffDelayMs,
  claimDuePosts,
  completePost,
  failPost,
  pendingPlatforms,
  publishTargets,
  recordAttempt,
  releaseStaleClaims,
  renewClaim,
} from "../src/scheduler.js";
import { testDatabaseUrl } from "./setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.post.deleteMany();
});

const duePost = (overrides: Record<string, unknown> = {}) =>
  prisma.post.create({
    data: {
      content: "hello world",
      status: "SCHEDULED",
      platforms: ["LINKEDIN"],
      scheduledFor: new Date(Date.now() - 1000),
      ...overrides,
    },
  });

describe("claim leases", () => {
  it("sets a lease and counts the attempt when claiming", async () => {
    const post = await duePost();
    const now = new Date();

    const [claimed] = await claimDuePosts(prisma, "worker-a", { now, claimTimeoutMs: 60_000 });

    expect(claimed?.id).toBe(post.id);
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.claimExpiresAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it("does not claim a post whose backoff has not elapsed", async () => {
    await duePost({ nextAttemptAt: new Date(Date.now() + 60_000) });

    expect(await claimDuePosts(prisma, "worker-a", { limit: 5 })).toHaveLength(0);
  });
});

describe("releaseStaleClaims", () => {
  it("requeues a post whose worker died, with backoff", async () => {
    const post = await duePost();
    await claimDuePosts(prisma, "dead-worker", { claimTimeoutMs: -1 });

    const result = await releaseStaleClaims(prisma);

    expect(result).toEqual({ requeued: 1, failed: 0 });
    const requeued = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(requeued.status).toBe("SCHEDULED");
    expect(requeued.claimedBy).toBeNull();
    expect(requeued.nextAttemptAt).not.toBeNull();
    expect(requeued.lastError).toMatch(/lease expired/i);
  });

  it("fails a post that exhausted its attempts instead of requeuing it forever", async () => {
    const post = await duePost({ attemptCount: 2, maxAttempts: 3 });
    await claimDuePosts(prisma, "dead-worker", { claimTimeoutMs: -1 });

    expect(await releaseStaleClaims(prisma)).toEqual({ requeued: 0, failed: 1 });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("FAILED");
  });

  it("leaves a live claim alone", async () => {
    await duePost();
    await claimDuePosts(prisma, "worker-a", { claimTimeoutMs: 60_000 });

    expect(await releaseStaleClaims(prisma)).toEqual({ requeued: 0, failed: 0 });
  });
});

describe("failPost", () => {
  it("reschedules with exponential backoff while attempts remain", async () => {
    const post = await duePost();
    const now = new Date();
    await claimDuePosts(prisma, "worker-a", { now });

    const failed = await failPost(prisma, post.id, "linkedin: 500", { now, backoffMs: 1000 });

    expect(failed?.status).toBe("SCHEDULED");
    expect(failed?.lastError).toBe("linkedin: 500");
    expect(failed?.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
  });

  it("gives up once maxAttempts is used", async () => {
    const post = await duePost({ attemptCount: 2, maxAttempts: 3 });
    await claimDuePosts(prisma, "worker-a");

    expect((await failPost(prisma, post.id, "linkedin: 500"))?.status).toBe("FAILED");
  });

  it("does not reschedule a post whose claim was already reaped", async () => {
    const post = await duePost();
    const [claimed] = await claimDuePosts(prisma, "slow-worker", { claimTimeoutMs: -1 });
    await releaseStaleClaims(prisma);

    expect(await failPost(prisma, post.id, "linkedin: 500", { claimToken: claimed?.claimToken ?? "" })).toBeNull();
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).lastError).toMatch(/lease expired/i);
  });

  it("backs off exponentially and stays capped at a day", () => {
    expect(backoffDelayMs(1, 1000)).toBe(1000);
    expect(backoffDelayMs(3, 1000)).toBe(4000);
    expect(backoffDelayMs(50, 1000)).toBe(24 * 60 * 60_000);
  });
});

describe("per-platform attempts", () => {
  it("upserts one row per post/platform so retries are idempotent", async () => {
    const post = await duePost();

    await recordAttempt(prisma, { postId: post.id, platform: "LINKEDIN", status: "FAILED", error: "boom" });
    await recordAttempt(prisma, { postId: post.id, platform: "LINKEDIN", status: "SUCCESS", externalPostId: "urn:1" });

    const attempts = await prisma.platformPublishAttempt.findMany({ where: { postId: post.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("SUCCESS");
    expect(attempts[0]?.externalPostId).toBe("urn:1");
  });

  it("only returns platforms that have not succeeded", async () => {
    const post = await duePost({ platforms: ["LINKEDIN", "FACEBOOK"] });
    await recordAttempt(prisma, { postId: post.id, platform: "LINKEDIN", status: "SUCCESS", externalPostId: "urn:1" });

    expect(await pendingPlatforms(prisma, post.id, ["LINKEDIN", "FACEBOOK"])).toEqual(["FACEBOOK"]);
  });
});

describe("completePost", () => {
  it("clears the lease and the last error when publishing succeeds", async () => {
    const post = await duePost({ lastError: "previous failure" });
    await claimDuePosts(prisma, "worker-a");

    const published = await completePost(prisma, post.id, "PUBLISHED");

    expect(published?.status).toBe("PUBLISHED");
    expect(published?.claimExpiresAt).toBeNull();
    expect(published?.lastError).toBeNull();
  });

  it("refuses to publish under a claim token that is no longer current", async () => {
    const post = await duePost();
    const [claimed] = await claimDuePosts(prisma, "slow-worker", { claimTimeoutMs: -1 });
    await releaseStaleClaims(prisma);
    await claimDuePosts(prisma, "worker-b", { now: new Date(Date.now() + 60 * 60_000) });

    expect(await completePost(prisma, post.id, "PUBLISHED", { claimToken: claimed?.claimToken ?? "" })).toBeNull();
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).claimedBy).toBe("worker-b");
  });
});

describe("renewClaim", () => {
  it("extends a live lease so a slow worker is not reaped", async () => {
    const post = await duePost();
    const [claimed] = await claimDuePosts(prisma, "worker-a", { claimTimeoutMs: 1000 });

    expect(await renewClaim(prisma, post.id, claimed?.claimToken ?? "", { claimTimeoutMs: 60_000 })).toBe(true);
    expect(await releaseStaleClaims(prisma)).toEqual({ requeued: 0, failed: 0 });
  });

  it("reports a lost lease once the claim was requeued", async () => {
    const post = await duePost();
    const [claimed] = await claimDuePosts(prisma, "worker-a", { claimTimeoutMs: -1 });
    await releaseStaleClaims(prisma);

    expect(await renewClaim(prisma, post.id, claimed?.claimToken ?? "")).toBe(false);
  });
});

describe("publishTargets", () => {
  it("keeps a platform interrupted mid-publish out of the retry", async () => {
    const post = await duePost({ platforms: ["LINKEDIN", "FACEBOOK"] });
    await recordAttempt(prisma, { postId: post.id, platform: "LINKEDIN", status: "PENDING" });

    expect(await publishTargets(prisma, post.id, ["LINKEDIN", "FACEBOOK"])).toEqual({
      pending: ["FACEBOOK"],
      unconfirmed: ["LINKEDIN"],
    });
  });
});
