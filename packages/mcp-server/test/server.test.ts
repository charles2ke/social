import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/client.js";
import { createServer } from "../src/server.js";

type Call = { method: string; url: string; authorization: string | null; body?: unknown };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function connect(respond: (call: Call) => Response = () => json({})) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  };
  const server = createServer(createApiClient({ baseUrl: "http://api.test/social", token: "admin-token", fetch }));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]?.text ?? "";

describe("MCP server", () => {
  it("publishes through the API with the admin token and per-platform text", async () => {
    const { client, calls } = await connect(() => json([{ platform: "linkedin", status: "published" }]));
    const result = await client.callTool({ name: "publish_post", arguments: { platforms: ["linkedin"], text: "Hi", platformOverrides: { linkedin: { text: "Hi LinkedIn" } } } });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual([{ platform: "linkedin", status: "published" }]);
    expect(calls).toEqual([
      { method: "POST", url: "http://api.test/social/publish", authorization: "Bearer admin-token", body: { platforms: ["linkedin"], text: "Hi", platformOverrides: { linkedin: { text: "Hi LinkedIn" } } } },
    ]);
  });

  it("reports API errors as tool errors", async () => {
    const { client } = await connect(() => json({ error: "linkedin posts are limited to 3000 characters, this one has 3001" }, 400));
    const result = await client.callTool({ name: "publish_post", arguments: { platforms: ["linkedin"], text: "x".repeat(3001) } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Social API error (HTTP 400): linkedin posts are limited to 3000 characters, this one has 3001");
  });

  it("refuses ids that would change the request path", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({ name: "cancel_scheduled", arguments: { id: "../accounts" } }).catch((error: unknown) => ({ isError: true, error }));
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("reads posts as resources", async () => {
    const id = "c1a2b3c4d5e6f7g8h9i0j1k2";
    const { client, calls } = await connect(() => json({ id, status: "scheduled" }));
    const resource = await client.readResource({ uri: `social://posts/${id}` });
    expect(JSON.parse(String(resource.contents[0]?.text))).toEqual({ id, status: "scheduled" });
    expect(calls[0]?.url).toBe(`http://api.test/social/posts/${id}`);
  });
});

describe("API client", () => {
  it("rejects unsafe API URLs and explains unreachable APIs", async () => {
    expect(() => createApiClient({ baseUrl: "file:///etc/passwd" })).toThrow(/http\(s\)/);
    expect(() => createApiClient({ baseUrl: "http://user:pass@api.test" })).toThrow(/credentials/);
    const api = createApiClient({ baseUrl: "http://api.test", fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    await expect(api.request("GET", "accounts")).rejects.toThrow("Could not call the Social API at http://api.test: it is not reachable");
  });
});
