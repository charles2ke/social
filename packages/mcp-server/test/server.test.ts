import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike } from "@social/core";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api.js";
import { createSocialMcpServer } from "../src/server.js";

const apiUrl = "http://api.test";
const adminToken = "admin-token-4f9c2b7e1d";

type Route = (body: Record<string, unknown>) => { status?: number; body?: unknown };
type Recorded = { method: string; path: string; headers: Record<string, string>; body?: Record<string, unknown> };

/** A fake Social API that answers `routes["METHOD /path"]` and records every request. */
function fakeApi(routes: Record<string, Route>) {
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const method = init.method ?? "GET";
    const path = input.slice(apiUrl.length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, headers: init.headers as Record<string, string>, body });
    const route = routes[`${method} ${path}`];
    const { status = 200, body: payload } = route ? route(body ?? {}) : { status: 404, body: { error: "Not Found" } };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { requests, fetch };
}

async function connect(fetch: FetchLike, options: { adminToken?: string } = { adminToken }) {
  const server = createSocialMcpServer({ apiUrl, ...options, fetch });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const texts = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[]).map((item) => item.text);

describe("MCP server", () => {
  it("saves drafts through the API, authenticated with the admin token", async () => {
    const api = fakeApi({ "POST /drafts": (body) => ({ status: 201, body: { id: "p1", status: "draft", ...body } }) });
    const client = await connect(api.fetch);
    const draft = { text: "Launch day", platforms: ["linkedin"], perPlatformOverrides: { linkedin: { text: "Launch day, in more detail" } } };

    const result = await client.callTool({ name: "create_draft", arguments: draft });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0])).toMatchObject({ id: "p1", status: "draft" });
    expect(api.requests).toEqual([
      { method: "POST", path: "/drafts", headers: expect.objectContaining({ authorization: `Bearer ${adminToken}`, "content-type": "application/json" }), body: draft },
    ]);
  });

  it("sends only the fields an update changes, and no token when none is configured", async () => {
    const api = fakeApi({ "POST /drafts/p%201": () => ({ body: { id: "p 1" } }) });
    const client = await connect(api.fetch, {});

    await client.callTool({ name: "update_draft", arguments: { id: "p 1", platforms: ["facebook"] } });

    expect(api.requests[0]).toMatchObject({ method: "POST", path: "/drafts/p%201", body: { platforms: ["facebook"] } });
    expect(Object.keys(api.requests[0].body ?? {})).toEqual(["platforms"]);
    expect(api.requests[0].headers).not.toHaveProperty("authorization");
  });

  it("rejects fields a platform's version does not have instead of dropping them", async () => {
    const api = fakeApi({});
    const client = await connect(api.fetch);

    const result = await client.callTool({ name: "create_draft", arguments: { text: "Hi", perPlatformOverrides: { linkedin: { caption: "Hi there" } } } });

    expect(result.isError).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it("saves a post before publishing it, and points at the retry when a platform fails", async () => {
    const api = fakeApi({
      "POST /drafts": () => ({ status: 201, body: { id: "p1", status: "draft" } }),
      "POST /posts/p1/publish": () => ({
        body: {
          post: { id: "p1", status: "failed" },
          results: [
            { platform: "linkedin", status: "published", platformPostId: "urn:li:share:1" },
            { platform: "facebook", status: "failed", error: "Token expired" },
          ],
        },
      }),
    });
    const client = await connect(api.fetch);

    const result = await client.callTool({ name: "publish_post", arguments: { text: "Hi", platforms: ["linkedin", "facebook"] } });

    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["POST /drafts", "POST /posts/p1/publish"]);
    expect(api.requests[0].body).toEqual({ text: "Hi", platforms: ["linkedin", "facebook"] });
    const [published, note] = texts(result);
    expect(JSON.parse(published).results).toHaveLength(2);
    expect(note).toContain("failed on facebook");
    expect(note).toContain("publish_saved_post (id p1)");
  });

  it("warns that a scheduled post is never published while the API keeps posts in memory", async () => {
    for (const [database, warned] of [["memory", true], ["up", false]] as const) {
      const api = fakeApi({
        "POST /schedule": (body) => ({ status: 201, body: { id: "p1", status: "scheduled", ...body } }),
        "GET /ready": () => ({ body: { ok: true, database } }),
      });
      const client = await connect(api.fetch);

      const result = await client.callTool({ name: "schedule_post", arguments: { text: "Later", platforms: ["linkedin"], scheduledFor: "2030-01-31T09:00:00Z" } });

      expect(api.requests[0]).toMatchObject({ path: "/schedule", body: { text: "Later", scheduledFor: "2030-01-31T09:00:00Z" } });
      expect(texts(result).some((text) => text.includes("never published"))).toBe(warned);
    }
  });

  it("reports API errors as tool errors without echoing the admin token", async () => {
    const api = fakeApi({
      "POST /posts/p1/cancel": () => ({ status: 409, body: { error: `Post is already published (sent with Authorization: Bearer ${adminToken})` } }),
      "GET /accounts": () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    const client = await connect(api.fetch);

    const conflict = await client.callTool({ name: "cancel_scheduled", arguments: { id: "p1" } });
    const unauthorized = await client.callTool({ name: "list_accounts", arguments: {} });

    expect(conflict.isError).toBe(true);
    expect(texts(conflict)[0]).toMatch(/^Post is already published .*\(HTTP 409\)$/);
    expect(JSON.stringify(conflict)).not.toContain(adminToken);
    expect(unauthorized.isError).toBe(true);
    expect(texts(unauthorized)[0]).toContain("Set ADMIN_TOKEN");
  });

  it("explains when the API cannot be reached", async () => {
    const client = await connect(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3001") });
    });

    const result = await client.callTool({ name: "list_platforms", arguments: {} });

    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("Could not reach the Social API at http://api.test (connect ECONNREFUSED 127.0.0.1:3001)");
  });

  it("reports whether a platform has a connected account", async () => {
    const api = fakeApi({ "GET /accounts": () => ({ body: [{ id: "a1", platform: "linkedin", name: "Ada" }] }) });
    const client = await connect(api.fetch);

    const linkedin = await client.callTool({ name: "get_account_status", arguments: { platform: "linkedin" } });
    const facebook = await client.callTool({ name: "get_account_status", arguments: { platform: "facebook" } });

    expect(JSON.parse(texts(linkedin)[0])).toEqual({ connected: true, id: "a1", platform: "linkedin", name: "Ada" });
    expect(JSON.parse(texts(facebook)[0])).toEqual({ connected: false, platform: "facebook" });
  });

  it("refuses ids that URL parsing would resolve to another route", async () => {
    const api = fakeApi({});
    const client = await connect(api.fetch);

    // fetch resolves /posts/../publish to /publish, which publishes without saving the post.
    const results = await Promise.all([
      ...["..", ".", ""].map((id) => client.callTool({ name: "publish_saved_post", arguments: { id, platforms: ["linkedin"] } })),
      client.callTool({ name: "get_analytics", arguments: { platform: "linkedin", postId: ".." } }),
    ]);

    expect(results.map((result) => [result.isError, texts(result)[0]])).toEqual([
      [true, '".." is not a valid id.'],
      [true, '"." is not a valid id.'],
      [true, '"" is not a valid id.'],
      [true, '".." is not a valid id.'],
    ]);
    expect(api.requests).toEqual([]);
  });

  it("reads a post resource from the API", async () => {
    const api = fakeApi({ "GET /posts/p1": () => ({ body: { id: "p1", status: "scheduled" } }) });
    const client = await connect(api.fetch);

    const resource = await client.readResource({ uri: "social://posts/p1" });

    expect(JSON.parse(String(resource.contents[0].text))).toEqual({ id: "p1", status: "scheduled" });
  });

  it("refuses an API URL that carries credentials", () => {
    expect(() => createApiClient({ apiUrl: "https://user:secret@api.test" })).toThrow("must not contain credentials");
  });
});
