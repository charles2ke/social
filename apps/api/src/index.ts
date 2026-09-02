import Fastify from "fastify";
import { adapters, MediaValidationError, normalizeMedia, validateMedia, type MediaAttachment, type PlatformId } from "@social/core";
import { store } from "./store.js";
const app = Fastify({ logger: false, bodyLimit: Number(process.env.API_BODY_LIMIT ?? 1_048_576) });
type DraftBody = { text: string; mediaUrls?: string[]; media?: MediaAttachment[] };
/** Merge `media`/`mediaUrls` into typed attachments, returning the validation error instead of throwing. */
function resolveMedia(body: Partial<DraftBody>): MediaAttachment[] | Error {
  try { return normalizeMedia(body); } catch (error) { return error instanceof MediaValidationError ? error : new Error("Invalid media"); }
}
// Every route replies with JSON only; nosniff keeps a browser from rendering echoed draft text as HTML.
app.addHook("onSend", async (_request, reply) => { reply.header("X-Content-Type-Options", "nosniff"); reply.type("application/json"); });
app.get("/health", async () => ({ ok: true }));
app.get("/platforms", async () => Object.values(adapters).map(({ id, capabilities, mediaConstraints }) => ({ id, capabilities, mediaConstraints })));
app.get("/accounts", async () => store.addMockAccounts());
app.get("/drafts", async () => store.drafts());
app.post<{ Body: DraftBody }>("/drafts", async (request, reply) => {
  const media = resolveMedia(request.body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  return reply.code(201).type("application/json").send(store.createDraft({ ...request.body, media }));
});
app.post<{ Params: { id: string }; Body: Partial<DraftBody> }>("/drafts/:id", async (request, reply) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.id)) return reply.code(400).send({ error: "Invalid draft id" });
  const media = resolveMedia(request.body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  const draft = store.updateDraft(request.params.id, { ...request.body, media });
  return draft ? reply.type("application/json").send(draft) : reply.code(404).send({ error: "Draft not found" });
});
app.post<{ Body: DraftBody & { platforms: PlatformId[] } }>("/publish", async (request, reply) => {
  const accessToken = process.env.MOCK_MODE === "true" ? "mock" : process.env.SOCIAL_ACCESS_TOKEN;
  if (!accessToken) return reply.code(401).send({ error: "No connected account token is available" });
  const { platforms, ...body } = request.body;
  if (!platforms?.length) return reply.code(400).send({ error: "At least one platform is required" });
  const invalid = platforms.filter((platform) => !(platform in adapters));
  if (invalid.length) return reply.code(400).send({ error: `Unknown platform(s): ${invalid.join(", ")}` });
  const media = resolveMedia(body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  const draft = { ...body, media };
  return Promise.all(platforms.map(async (platform) => {
    try { return { platform, status: "published" as const, ...(await adapters[platform].publish({ accessToken }, draft)) }; }
    catch (error) { return { platform, status: "failed" as const, error: error instanceof Error ? error.message : "Publishing failed" }; }
  }));
});
/** Media compatibility for a draft, per platform — lets clients warn before publishing. */
app.post<{ Body: DraftBody }>("/media/validate", async (request, reply) => {
  const media = resolveMedia(request.body);
  if (media instanceof Error) return reply.code(400).send({ error: media.message });
  return Object.values(adapters).map((adapter) => {
    try { validateMedia(adapter.id, adapter.capabilities, adapter.mediaConstraints, media); return { platform: adapter.id, compatible: true }; }
    catch (error) { return { platform: adapter.id, compatible: false, reason: error instanceof Error ? error.message : "Incompatible media" }; }
  });
});
app.listen({ port: Number(process.env.API_PORT ?? 3001), host: "0.0.0.0" }).catch((error: unknown) => { console.error(error); process.exit(1); });
