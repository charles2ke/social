import Fastify from "fastify";
import { adapters, type PlatformId } from "@social/core";
import { store } from "./store.js";
const app = Fastify({ logger: false });
app.get("/health", async () => ({ ok: true }));
app.get("/platforms", async () => Object.values(adapters).map(({ id, capabilities }) => ({ id, capabilities })));
app.get("/accounts", async () => store.addMockAccounts());
app.get("/drafts", async () => store.drafts());
app.post<{ Body: { text: string; mediaUrls?: string[] } }>("/drafts", async (request, reply) => reply.code(201).send(store.createDraft(request.body)));
app.post<{ Params: { id: string }; Body: { text?: string; mediaUrls?: string[] } }>("/drafts/:id", async (request, reply) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.id)) return reply.code(400).send({ error: "Invalid draft id" });
  const draft = store.updateDraft(request.params.id, request.body);
  return draft ? reply.send(draft) : reply.code(404).send({ error: "Draft not found" });
});
app.post<{ Body: { text: string; platforms: PlatformId[]; mediaUrls?: string[] } }>("/publish", async (request, reply) => {
  const accessToken = process.env.MOCK_MODE === "true" ? "mock" : process.env.SOCIAL_ACCESS_TOKEN;
  if (!accessToken) return reply.code(401).send({ error: "No connected account token is available" });
  return Promise.all(request.body.platforms.map(async (platform) => {
    const adapter = adapters[platform]; return { platform, ...(await adapter.publish({ accessToken }, request.body)) };
  }));
});
app.listen({ port: Number(process.env.API_PORT ?? 3001), host: "0.0.0.0" }).catch((error: unknown) => { console.error(error); process.exit(1); });
