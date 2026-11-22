import { describe, expect, it, beforeEach } from "vitest";
import { adapters, createAdapters, decrypt, encrypt, inferMediaKind, MediaValidationError, normalizeMedia, publishDue, textProblems, TextValidationError } from "../src/index.js";
beforeEach(() => { process.env.ENCRYPTION_KEY = "a".repeat(64); });
describe("core", () => {
  it("encrypts tokens with authenticated encryption", () => expect(decrypt(encrypt("secret"))).toBe("secret"));
  it("rejects a truncated authentication tag", () => {
    const [iv, tag, body] = encrypt("secret").split(".");
    const shortTag = Buffer.from(tag!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decrypt([iv, shortTag, body].join("."))).toThrow(/Invalid encrypted value/);
  });
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
  it("validates untrusted attachment fields and drops unknown ones", () => {
    const parse = (media: unknown, mediaUrls?: unknown) => () => normalizeMedia({ media, mediaUrls } as never);
    expect(parse([{ url: "https://cdn.example/a.png", kind: "__proto__" }])).toThrow(/kind must be/);
    expect(parse([{ url: 42 }])).toThrow(MediaValidationError);
    expect(parse([{ url: "javascript:alert(1)", kind: "image" }])).toThrow(/http/);
    expect(parse([{ url: "https://user:pw@cdn.example/a.png" }])).toThrow(/credentials/);
    expect(parse([{ url: "https://cdn.example/a.png", altText: { html: true } }])).toThrow(/altText/);
    expect(parse("https://cdn.example/a.png")).toThrow(/must be an array/);
    expect(parse([], Array.from({ length: 21 }, (_, index) => `https://cdn.example/${index}.png`))).toThrow(/at most 20/);
    expect(normalizeMedia({ media: [{ url: "https://cdn.example/a.png", extra: "x" } as never] })).toEqual([{ url: "https://cdn.example/a.png", kind: "image" }]);
  });
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
  beforeEach(() => { process.env.MOCK_MODE = "true"; });
  it("checks the whole text, or a title-first platform's title and description separately", () => {
    expect(textProblems("linkedin", adapters.linkedin.textConstraints, "x".repeat(3000))).toEqual([]);
    expect(textProblems("linkedin", adapters.linkedin.textConstraints, "x".repeat(3001))).toEqual(["linkedin posts are limited to 3000 characters, this one has 3001"]);
    expect(textProblems("youtube", adapters.youtube.textConstraints, `${"t".repeat(101)}\n${"d".repeat(5001)}`)).toHaveLength(2);
    expect(textProblems("strava", adapters.strava.textConstraints, `${"t".repeat(255)}\n${"d".repeat(10_000)}`)).toEqual([]);
  });
  it("rejects over-limit text at publish time instead of truncating it, per platform override", async () => {
    const mock = createAdapters({ env: { MOCK_MODE: "true" } });
    await expect(mock.tiktok.publish({ accessToken: "mock" }, { text: "x".repeat(2201), mediaUrls: ["https://cdn.example/a.mp4"] })).rejects.toThrow(TextValidationError);
    const draft = { text: "x".repeat(3001), perPlatformOverrides: { linkedin: { text: "Short for LinkedIn" } } };
    await expect(mock.linkedin.publish({ accessToken: "mock" }, draft)).resolves.toMatchObject({ platformPostId: expect.stringMatching(/^linkedin-/) });
    await expect(mock.whatsapp.publish({ accessToken: "mock" }, { ...draft, text: "x".repeat(4097) })).rejects.toThrow(/4096 characters/);
  });
});
