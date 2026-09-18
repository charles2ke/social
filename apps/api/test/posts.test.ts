import { describe, expect, it } from "vitest";
import { createMemoryPostRepository } from "../src/posts.js";

const media = [{ url: "https://example.com/a.jpg", kind: "image" as const }];

describe("post repository", () => {
  it("creates a draft that is not scheduled", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello", media });
    expect(draft).toMatchObject({ text: "hello", status: "draft", media });
    expect(await posts.list("draft")).toHaveLength(1);
    expect(await posts.list("scheduled")).toHaveLength(0);
  });

  it("schedules a draft for the worker to pick up", async () => {
    const posts = createMemoryPostRepository();
    const draft = await posts.create({ text: "hello" });
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

  it("returns undefined for an unknown id", async () => {
    const posts = createMemoryPostRepository();
    expect(await posts.get("missing")).toBeUndefined();
    expect(await posts.update("missing", { text: "x" })).toBeUndefined();
    expect(await posts.cancel("missing")).toBeUndefined();
  });
});
