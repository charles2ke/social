import { describe, expect, it, vi } from "vitest";
import type { PlatformId } from "@social/core";
import { createMemoryPostRepository } from "../src/posts.js";

const media = [{ url: "https://example.com/a.jpg", kind: "image" as const }];
const published = async (platform: PlatformId) => ({ platformPostId: `${platform}-1`, publishedAt: new Date() });

describe("post repository", () => {
  it("validates the current merged post before edits, scheduling and publishing", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    const when = new Date(Date.now() + 60_000);
    await posts.schedule(draft.id, when);
    await expect(posts.update(draft.id, { platforms: [] })).rejects.toThrow("At least one platform is required");
    await expect(posts.update(draft.id, { platformOverrides: { linkedin: { text: "x".repeat(3001) } } })).rejects.toThrow();
    expect(await posts.get(draft.id)).toMatchObject({ status: "scheduled", platforms: ["linkedin"], text: "hello" });

    const other = await posts.create({ text: "hello", platforms: ["linkedin"] });
    await posts.update(other.id, { text: "x".repeat(3001) });
    await expect(posts.schedule(other.id, when)).rejects.toThrow();
    const publish = vi.fn(published);
    await expect(posts.publishNow(other.id, { publish })).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(await posts.get(other.id)).toMatchObject({ status: "draft", text: "x".repeat(3001) });
    await posts.update(other.id, { text: "hello", platforms: [] });
    await expect(posts.publishNow(other.id, { publish })).rejects.toThrow("At least one platform is required");
  });

  it("creates a draft that is not scheduled", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", media });
    expect(draft).toMatchObject({ text: "hello", status: "draft", media });
    expect(await posts.list("draft")).toHaveLength(1);
    expect(await posts.list("scheduled")).toHaveLength(0);
  });

  it("schedules a draft for the worker to pick up", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    const when = new Date(Date.now() + 60_000);

    const scheduled = await posts.schedule(draft.id, when);

    expect(scheduled).toMatchObject({ id: draft.id, status: "scheduled", scheduledFor: when.toISOString() });
  });

  it("keeps existing media on a text-only update", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", media });

    const updated = await posts.update(draft.id, { text: "goodbye" });

    expect(updated).toMatchObject({ text: "goodbye", media });
  });

  it("cancels a scheduled post", async () => {
    const posts = createMemoryPostRepository();
    const post = await posts.create({ text: "hello", platforms: ["linkedin"], scheduledFor: new Date() });

    expect(await posts.cancel(post.id)).toMatchObject({ status: "cancelled" });
  });

  it("refuses to requeue a cancelled post", async () => {
    const posts = createMemoryPostRepository();
    const post = await posts.create({ text: "hello", platforms: ["linkedin"], scheduledFor: new Date() });
    await posts.cancel(post.id);

    expect(await posts.schedule(post.id, new Date(Date.now() + 60_000))).toMatchObject({ status: "cancelled" });
  });

  it("returns undefined for an unknown id", async () => {
    const posts = createMemoryPostRepository();
    expect(await posts.get("missing")).toBeUndefined();
    expect(await posts.update("missing", { text: "x" })).toBeUndefined();
    expect(await posts.cancel("missing")).toBeUndefined();
    expect(await posts.publishNow("missing", { publish: vi.fn(published) })).toBeUndefined();
  });

  it("lists the newest post first", async () => {
    const posts = createMemoryPostRepository();
    await posts.create({ text: "first" });
    await posts.create({ text: "second" });

    expect((await posts.list()).map((post) => post.text)).toEqual(["second", "first"]);
  });

  it("does not edit a post that was already published", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    await posts.publishNow(draft.id, { publish: vi.fn(published) });

    expect(await posts.update(draft.id, { text: "changed" })).toMatchObject({ text: "hello", status: "published" });
  });
});

describe("publishing a stored post now", () => {
  it("applies the changes, publishes to every platform and records the attempts", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    const publish = vi.fn(published);

    const result = await posts.publishNow(draft.id, { publish }, { text: "edited", platforms: ["linkedin", "facebook"] });

    expect(publish.mock.calls.map(([platform, post]) => [platform, post.text])).toEqual([["linkedin", "edited"], ["facebook", "edited"]]);
    expect(result).toMatchObject({
      claimed: true,
      post: { status: "published", text: "edited", attempts: [{ platform: "linkedin", status: "success" }, { platform: "facebook", status: "success" }] },
      results: [{ platform: "linkedin", status: "published", platformPostId: "linkedin-1" }, { platform: "facebook", status: "published" }],
    });
  });

  it("fails the post with the error, then retries only the platform that failed", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin", "facebook"] });
    const facebookDown = vi.fn(async (platform: PlatformId) => {
      if (platform === "facebook") throw new Error('Facebook is down {"access_token":"secret-token"}');
      return published(platform);
    });

    const failed = await posts.publishNow(draft.id, { publish: facebookDown });
    expect(failed?.post).toMatchObject({ status: "failed", lastError: expect.stringContaining("facebook: Facebook is down") });
    expect(failed?.post.lastError).not.toContain("secret-token");

    const retry = vi.fn(published);
    const retried = await posts.publishNow(draft.id, { publish: retry });

    expect(retry.mock.calls.map(([platform]) => platform)).toEqual(["facebook"]);
    expect(retried?.post.status).toBe("published");
    expect(retried?.post.lastError).toBeUndefined();
  });

  it("refuses a cancelled post", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    await posts.cancel(draft.id);
    const publish = vi.fn(published);

    expect(await posts.publishNow(draft.id, { publish })).toMatchObject({ claimed: false, post: { status: "cancelled" } });
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses a second publish while the first is still in flight", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", platforms: ["linkedin"] });
    let finish: () => void = () => undefined;
    const slow = vi.fn(async (platform: PlatformId) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return published(platform);
    });

    const first = posts.publishNow(draft.id, { publish: slow });
    const second = await posts.publishNow(draft.id, { publish: slow });
    finish();

    expect(second).toMatchObject({ claimed: false, post: { status: "publishing" } });
    expect((await first)?.post.status).toBe("published");
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
