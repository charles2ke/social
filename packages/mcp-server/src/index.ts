#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSocialMcpServer } from "./server.js";

function createServer() {
  try {
    return createSocialMcpServer({ apiUrl: process.env.SOCIAL_API_URL || "http://localhost:3001", adminToken: process.env.ADMIN_TOKEN || undefined });
  } catch (error) {
    // stdout carries the MCP protocol, so configuration errors go to stderr.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

await createServer().connect(new StdioServerTransport());
