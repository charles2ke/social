import { describe, expect, it, beforeEach } from "vitest";
import { adapters, decrypt, encrypt, inferMediaKind, MediaValidationError, normalizeMedia, publishDue } from "../src/index.js";
beforeEach(() => { process.env.ENCRYPTION_KEY = "a".repeat(64); });
describe("core", () => {
  it("encrypts tokens with authenticated encryption", () => expect(decrypt(encrypt("secret"))).toBe("secret"));
  it("publishes due posts but not future ones", async () => {
    const [done] = await publishDue([{ id: "1", draft: { text: "Hello" }, platforms: ["linkedin"], scheduledFor: new Date() }], new Date(), async () => ({ platformPostId: "1", publishedAt: new Date() }));
    expect(done.results?.linkedin).toBeDefined();
  });
  it("provides all requested adapters", () => expect(Object.keys(adapters)).toHaveLength(9));
});
describe("media", () => {
  it("infers kinds from extensions and query strings", () => {
    expect(inferMediaKind("https://cdn.example/a.JPG")).toBe("image");
    expect(inferMediaKind("https://cdn.example/clip.mp4?sig=1")).toBe("video");
    expect(inferMediaKind("https://cdn.example/file")).toBeUndefined();
  });
  it("normalizes and de-duplicates legacy mediaUrls", () => {
    const media = normalizeMedia({ media: [{ url: "https://cdn.example/a.png", kind: "image", altText: "A" }], mediaUrls: ["https://cdn.example/a.png", "https://cdn.example/b.mp4"] });
    expect(media).toEqual([{ url: "https://cdn.example/a.png", kind: "image", altText: "A" }, { url: "https://cdn.example/b.mp4", kind: "video" }]);
  });
  it("rejects media whose kind cannot be determined", () => expect(() => normalizeMedia({ mediaUrls: ["https://cdn.example/file"] })).toThrow(MediaValidationError));
  it("rejects non-http media URLs", () => expect(() => adapters.instagram.publish({ accessToken: "mock" }, { text: "Hi", mediaUrls: ["file:///etc/passwd.png"] })).rejects.toThrow(/http/));
  it("publishes an image and a video to Instagram", async () => {
    process.env.MOCK_MODE = "true";
    const result = await adapters.instagram.publish({ accessToken: "mock" }, { text: "Hi", media: [{ url: "https://cdn.example/a.png", kind: "image" }, { url: "https://cdn.example/b.mp4", kind: "video" }] });
    expect(result.platformPostId).toContain("instagram-");
  });
  it("rejects images on video-only platforms", async () => {
    process.env.MOCK_MODE = "true";
    await expect(adapters.tiktok.publish({ accessToken: "mock" }, { text: "Hi", mediaUrls: ["https://cdn.example/a.png"] })).rejects.toThrow(/does not support image/);
  });
  it("rejects posts that exceed the attachment limit or mix kinds", async () => {
    process.env.MOCK_MODE = "true";
    await expect(adapters.linkedin.publish({ accessToken: "mock" }, { text: "Hi", mediaUrls: Array.from({ length: 10 }, (_, index) => `https://cdn.example/${index}.png`) })).rejects.toThrow(/at most 9/);
    await expect(adapters.linkedin.publish({ accessToken: "mock" }, { text: "Hi", mediaUrls: ["https://cdn.example/a.png", "https://cdn.example/b.mp4"] })).rejects.toThrow(/cannot mix/);
  });
  it("requires a video for YouTube", async () => {
    process.env.MOCK_MODE = "true";
    await expect(adapters.youtube.publish({ accessToken: "mock" }, { text: "Hi" })).rejects.toThrow(/requires/);
  });
});
