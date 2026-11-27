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
  it.each(["update", "schedule", "publish-platforms", "publish-override"] as const)(
    "validates the committed state after waiting for a concurrent %s edit",
    async (operation) => {
      const post = await posts.create({ text: "short", platforms: ["linkedin"] });
      const when = new Date(Date.now() + 60_000);
      let release = () => {};
      let ready: (pid: number) => void = () => {};
      const locked = new Promise<number>((resolve) => { ready = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const concurrent = prisma.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.post.update({
          where: { id: post.id },
          data: operation === "update"
            ? { status: "SCHEDULED", scheduledFor: when }
            : operation === "schedule"
              ? { content: "x".repeat(3001) }
              : operation === "publish-platforms"
                ? { platforms: [] }
                : { platformOverrides: { linkedin: { text: "x".repeat(3001) } } },
        });
        ready(pid);
        await hold;
      });
      const pid = await locked;
      const publish = vi.fn(published);
      const mutation = operation === "update"
        ? posts.update(post.id, { platforms: [] })
        : operation === "schedule"
          ? posts.schedule(post.id, when, { platforms: ["linkedin"] })
          : posts.publishNow(post.id, { publish });
      const outcome = mutation.then(() => undefined, (error: unknown) => error);
      try {
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < deadline) {
          const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
          `;
          if (rows[0].blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await concurrent;
      }
      expect(await outcome).toBeInstanceOf(Error);
      expect(publish).not.toHaveBeenCalled();
      const current = await posts.get(post.id);
      expect(current?.status).toBe(operation === "update" ? "scheduled" : "draft");
      if (operation === "update") expect(current?.platforms).toEqual(["linkedin"]);
      if (operation === "publish-platforms") expect(current?.platforms).toEqual([]);
      if (operation === "schedule") expect(current?.text).toHaveLength(3001);
      if (operation === "publish-override") expect(current?.platformOverrides?.linkedin?.text).toHaveLength(3001);
    },
  );

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

  it("stores per-platform text and publishes it with the post", async () => {
    const draft = await posts.create({ text: "Main", platforms: ["linkedin"], platformOverrides: { linkedin: { text: "For LinkedIn" } } });
    expect(draft.platformOverrides).toEqual({ linkedin: { text: "For LinkedIn" } });
    const publish = vi.fn(published);

    await posts.publishNow(draft.id, { publish, accountIdFor: async () => undefined });

    expect(publish.mock.calls[0]?.[1].perPlatformOverrides).toEqual({ linkedin: { text: "For LinkedIn" } });
    const cleared = await posts.create({ text: "x", platformOverrides: { facebook: { text: "y" } } });
    expect(await posts.update(cleared.id, { platformOverrides: {} })).not.toHaveProperty("platformOverrides");
  });

  it("validates and publishes the merged override in the claim", async () => {
    const draft = await posts.create({ text: "x".repeat(3001), platforms: ["linkedin"] });
    const publish = vi.fn(published);
    const result = await posts.publishNow(draft.id, { publish }, { platformOverrides: { linkedin: { text: "short" } } });

    expect(result?.post).toMatchObject({ status: "published", platformOverrides: { linkedin: { text: "short" } } });
    expect(publish.mock.calls[0]?.[1].perPlatformOverrides).toEqual({ linkedin: { text: "short" } });
  });

  it("returns undefined for an unknown id", async () => {
    expect(await posts.publishNow("missing-post-id", { publish: vi.fn(published) })).toBeUndefined();
  });
});
