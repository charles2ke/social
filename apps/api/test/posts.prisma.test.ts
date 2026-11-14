import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformId } from "@social/core";
import { claimDuePosts, createPrismaClient, failPost } from "@social/db";
import { createPrismaPostRepository } from "../src/posts.js";
import { testDatabaseUrl } from "../../../packages/db/test/setup.js";

const prisma = createPrismaClient({ databaseUrl: testDatabaseUrl() });
const posts = await createPrismaPostRepository({ prisma });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.platformPublishAttempt.deleteMany();
  await prisma.post.deleteMany();
});

const published = async (platform: PlatformId) => ({ platformPostId: `${platform}-1`, publishedAt: new Date() });

describe("Postgres post repository", () => {
  it("publishes a draft now, recording one attempt per platform", async () => {
    const draft = await posts.create({ text: "hello", platforms: ["linkedin", "facebook"] });
    const publish = vi.fn(published);

    const result = await posts.publishNow(draft.id, { publish, accountIdFor: async () => undefined }, { text: "edited" });

    expect(publish.mock.calls.map(([platform, post]) => [platform, post.text])).toEqual([["linkedin", "edited"], ["facebook", "edited"]]);
    expect(result).toMatchObject({ claimed: true, post: { status: "published", text: "edited" } });
    expect(result?.claimed && result.results.map((outcome) => outcome.status)).toEqual(["published", "published"]);
    const row = await prisma.post.findUniqueOrThrow({ where: { id: draft.id }, include: { attempts: true } });
    expect(row).toMatchObject({ status: "PUBLISHED", claimToken: null, lastError: null });
    expect(row.attempts.map((attempt) => attempt.status)).toEqual(["SUCCESS", "SUCCESS"]);
  });

  it("fails the post without requeuing it, then retries only the platform that failed", async () => {
    const draft = await posts.create({ text: "hello", platforms: ["linkedin", "facebook"] });
    const facebookDown = vi.fn(async (platform: PlatformId) => {
      if (platform === "facebook") throw new Error("Facebook is down");
      return published(platform);
    });

    const failed = await posts.publishNow(draft.id, { publish: facebookDown });
    expect(failed?.post).toMatchObject({ status: "failed", lastError: "facebook: Facebook is down" });

    const retry = vi.fn(published);
    const retried = await posts.publishNow(draft.id, { publish: retry });

    expect(retry.mock.calls.map(([platform]) => platform)).toEqual(["facebook"]);
    expect(retried?.post.status).toBe("published");
    expect(retried?.post.lastError).toBeUndefined();
  });

  it("refuses a post the worker is already publishing", async () => {
    const row = await prisma.post.create({ data: { content: "busy", status: "PUBLISHING", platforms: ["LINKEDIN"], claimToken: "worker-claim" } });
    const publish = vi.fn(published);

    expect(await posts.publishNow(row.id, { publish })).toMatchObject({ claimed: false, post: { status: "publishing" } });
    expect(await posts.update(row.id, { text: "changed" })).toMatchObject({ text: "busy", status: "publishing" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("gives a requeued failed post a fresh retry budget", async () => {
    const row = await prisma.post.create({ data: { content: "retry me", status: "FAILED", platforms: ["LINKEDIN"], attemptCount: 3, maxAttempts: 3 } });

    const scheduled = await posts.schedule(row.id, new Date(Date.now() + 60_000));

    expect(scheduled?.status).toBe("scheduled");
    expect((await prisma.post.findUniqueOrThrow({ where: { id: row.id } })).attemptCount).toBe(0);
  });

  it("returns the worker's next retry time and clears it on rescheduling", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const scheduledFor = new Date("2026-01-01T00:00:00.000Z");
    const post = await posts.create({ text: "retry", platforms: ["linkedin"], scheduledFor });
    const [claimed] = await claimDuePosts(prisma, "worker", { now });
    await failPost(prisma, post.id, "temporary error", { now, claimToken: claimed.claimToken ?? undefined });
    const nextAttemptAt = new Date(now.getTime() + 60_000).toISOString();

    expect(await posts.get(post.id)).toMatchObject({ scheduledFor: scheduledFor.toISOString(), nextAttemptAt });
    expect(await posts.list("scheduled")).toMatchObject([{ id: post.id, nextAttemptAt }]);
    const rescheduled = await posts.schedule(post.id, new Date("2026-01-03T00:00:00.000Z"));
    expect(rescheduled?.nextAttemptAt).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await posts.publishNow("missing-post-id", { publish: vi.fn(published) })).toBeUndefined();
  });
});
