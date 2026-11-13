import { expect, test } from "@playwright/test";
import { apiOrigin } from "./servers";

// API behaviour the dashboard never triggers itself, checked against the same server the UI tests use.

test("scheduling a saved draft by id keeps the text and media it was saved with", async ({ request }) => {
  const image = { url: "https://cdn.example.com/keep.jpg", kind: "image", altText: "Kept" };
  const created = await request.post(`${apiOrigin}/drafts`, { data: { text: "Keep my media", media: [image], platforms: ["linkedin"] } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const scheduledFor = new Date(Date.now() + 86_400_000).toISOString();
  const response = await request.post(`${apiOrigin}/schedule`, { data: { id, platforms: ["linkedin", "facebook"], scheduledFor } });
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({
    id,
    status: "scheduled",
    text: "Keep my media",
    media: [image],
    platforms: ["linkedin", "facebook"],
    scheduledFor,
  });
});

test("checks each platform's version of a post against what it would reject, without publishing", async ({ request }) => {
  const image = { url: "https://cdn.example.com/still.jpg", kind: "image" };
  const video = { url: "https://cdn.example.com/clip.mp4", kind: "video" };
  const response = await request.post(`${apiOrigin}/validate`, {
    data: {
      text: "Launch <day>\nEverything we shipped",
      media: [image, video],
      platforms: ["youtube", "tiktok"],
      perPlatformOverrides: { youtube: { text: "Launch day\nEverything we shipped", media: [video] } },
    },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject([
    {
      platform: "youtube",
      ok: true,
      problems: [],
      text: [
        { field: "title", used: 10, max: 100, unit: "characters" },
        { field: "description", used: 21, max: 5000, unit: "bytes" },
      ],
    },
    { platform: "tiktok", ok: false, problems: ["tiktok does not support image attachments"] },
  ]);
});

test("rejects per-platform versions for unknown platforms or fields", async ({ request }) => {
  const save = (perPlatformOverrides: object) =>
    request.post(`${apiOrigin}/drafts`, { data: { text: "Hello", platforms: ["linkedin"], perPlatformOverrides } });

  const unknownPlatform = await save({ myspace: { text: "Hello" } });
  expect(unknownPlatform.status()).toBe(400);
  expect(await unknownPlatform.json()).toEqual({ error: "Unknown platform in perPlatformOverrides: myspace" });

  const unknownField = await save({ linkedin: { caption: "Hello" } });
  expect(unknownField.status()).toBe(400);
  expect(await unknownField.json()).toEqual({ error: "perPlatformOverrides.linkedin has unknown field(s): caption" });
});
