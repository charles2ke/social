import { expect, test } from "./fixtures";

// API behaviour the dashboard never triggers itself, checked against the same server the UI tests use.

test("scheduling a saved draft by id keeps the text and media it was saved with", async ({ api }) => {
  const image = { url: "https://cdn.example.com/keep.jpg", kind: "image", altText: "Kept" };
  const created = await api.post("/drafts", { data: { text: "Keep my media", media: [image], platforms: ["linkedin"] } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const scheduledFor = new Date(Date.now() + 86_400_000).toISOString();
  const response = await api.post("/schedule", { data: { id, platforms: ["linkedin", "facebook"], scheduledFor } });
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
