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
  const draft = store.updateDraft(request.params.id, request.body); return draft ? draft : reply.code(404).send({ error: "Draft not found" });
});
app.post<{ Body: { text: string; platforms: PlatformId[]; mediaUrls?: string[] } }>("/publish", async (request) => Promise.all(request.body.platforms.map(async (platform) => {
  const adapter = adapters[platform]; return { platform, ...(await adapter.publish({ accessToken: "mock" }, request.body)) };
})));
app.listen({ port: Number(process.env.API_PORT ?? 3001), host: "0.0.0.0" }).catch((error: unknown) => { console.error(error); process.exit(1); });
