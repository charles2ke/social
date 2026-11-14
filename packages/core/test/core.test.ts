import { describe, expect, it, beforeEach } from "vitest";
import {
  adapters,
  countText,
  decrypt,
  draftFor,
  encrypt,
  inferMediaKind,
  MediaValidationError,
  normalizeMedia,
  publishDue,
  textPart,
  textProblems,
  TextValidationError,
  validateText,
  type PostDraft,
  type TextLimit,
} from "../src/index.js";
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
  it("rejects non-http media URLs", async () => {
    await expect(adapters.instagram.publish({ accessToken: "mock" }, { text: "Hi", mediaUrls: ["file:///etc/passwd.png"] })).rejects.toThrow(/http/);
  });
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
describe("text limits", () => {
  it("counts characters, UTF-16 code units and bytes", () => {
    expect(countText("hi 👋", "characters")).toBe(4);
    expect(countText("hi 👋", "utf16")).toBe(5);
    expect(countText("hi 👋", "bytes")).toBe(7);
  });
  it("splits the text into its first line and the rest", () => {
    expect(textPart("Title\nBody\nMore", "firstLine")).toBe("Title");
    expect(textPart("Title\nBody\nMore", "rest")).toBe("Body\nMore");
    expect(textPart("Only a title", "firstLine")).toBe("Only a title");
    expect(textPart("Only a title", "rest")).toBe("");
  });
  it("reports every limit the text breaks, in the platform's unit", () => {
    const limits: TextLimit[] = [
      { field: "title", part: "firstLine", max: 5, unit: "characters", disallowed: ["<", ">"] },
      { field: "description", part: "rest", max: 4, unit: "bytes" },
    ];
    expect(textProblems("youtube", limits, "Short\néh!")).toEqual([]);
    expect(textProblems("youtube", limits, "Too long <b>\né!!!")).toEqual([
      "youtube allows at most 5 characters in the title (the first line), received 12",
      'youtube does not allow "<" or ">" in the title (the first line)',
      "youtube allows at most 4 bytes in the description (everything after the first line), received 5",
    ]);
    expect(() => validateText("youtube", limits, "Too long")).toThrow(TextValidationError);
  });
});
describe("per-platform drafts", () => {
  const image = (name: string) => ({ url: `https://cdn.example/${name}.png`, kind: "image" as const });
  const post: PostDraft = {
    text: "Main text",
    media: [image("main")],
    perPlatformOverrides: { linkedin: { text: "For LinkedIn" }, instagram: { mediaUrls: [image("square").url] }, facebook: { text: undefined } },
  };
  it("replaces only the fields an override sets", () => {
    expect(draftFor("linkedin", post)).toMatchObject({ text: "For LinkedIn", media: [image("main")] });
    expect(draftFor("facebook", post)).toMatchObject({ text: "Main text", media: [image("main")] });
    expect(draftFor("youtube", post)).toBe(post);
  });
  it("replaces the post's attachments instead of adding to them", () => {
    expect(normalizeMedia(draftFor("instagram", post))).toEqual([image("square")]);
  });
});
