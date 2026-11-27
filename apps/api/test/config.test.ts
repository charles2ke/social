import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const adminToken = "a".repeat(40);

describe("loadConfig", () => {
  it("requires a strong ADMIN_TOKEN outside mock mode", () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_TOKEN must be set/);
    expect(() => loadConfig({ ADMIN_TOKEN: "short" })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ MOCK_MODE: "true", ADMIN_TOKEN: "short" })).toThrow(/at least 32 characters/);
    expect(loadConfig({ ADMIN_TOKEN: ` ${adminToken} ` }).adminToken).toBe(adminToken);
  });

  it("keeps an open mock-mode API on localhost", () => {
    const config = loadConfig({ MOCK_MODE: "true" });
    expect(config).toMatchObject({ adminToken: undefined, host: "localhost", port: 3001 });
    expect([...config.allowedOrigins]).toEqual(["http://localhost:3000"]);
    expect(loadConfig({ ADMIN_TOKEN: adminToken }).host).toBe("0.0.0.0");
  });

  it("normalizes origins and rejects malformed settings", () => {
    const config = loadConfig({ ADMIN_TOKEN: adminToken, WEB_ORIGIN: "https://dash.example/, http://localhost:3000/setup" });
    expect([...config.allowedOrigins]).toEqual(["https://dash.example", "http://localhost:3000"]);
    expect(() => loadConfig({ ADMIN_TOKEN: adminToken, WEB_ORIGIN: "javascript:alert(1)" })).toThrow(/WEB_ORIGIN/);
    expect(() => loadConfig({ ADMIN_TOKEN: adminToken, BASE_URL: "dash.example" })).toThrow(/BASE_URL/);
    expect(() => loadConfig({ ADMIN_TOKEN: adminToken, API_RATE_LIMIT: "lots" })).toThrow(/API_RATE_LIMIT/);
    expect(() => loadConfig({ ADMIN_TOKEN: adminToken, API_PORT: "80.5" })).toThrow(/API_PORT/);
  });

  it("parses TRUST_PROXY as a flag, a hop count or an address list", () => {
    expect(loadConfig({ ADMIN_TOKEN: adminToken }).trustProxy).toBe(false);
    expect(loadConfig({ ADMIN_TOKEN: adminToken, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ADMIN_TOKEN: adminToken, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ ADMIN_TOKEN: adminToken, TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });
});
