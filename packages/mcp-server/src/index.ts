#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiClient } from "./client.js";
import { createServer } from "./server.js";

// stdout is the MCP channel: diagnostics go to stderr only.
try {
  const baseUrl = process.env.SOCIAL_API_URL?.trim() || "http://localhost:3001";
  const token = process.env.SOCIAL_API_TOKEN?.trim() || undefined;
  const { protocol, hostname } = new URL(baseUrl);
  if (token && protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    console.error(`Warning: SOCIAL_API_URL uses plain http, so SOCIAL_API_TOKEN travels unencrypted to ${hostname}`);
  }
  await createServer(createApiClient({ baseUrl, token })).connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
