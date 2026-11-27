import { describe, expect, it } from "vitest";
import { createOAuthStates } from "../src/oauth-state.js";

describe("oauth state", () => {
  it("round-trips the page to return to, once", () => {
    const states = createOAuthStates("state-secret");
    const state = states.create("linkedin", "https://dashboard.example/setup");
    expect(states.consume(state, "linkedin")).toEqual({ returnTo: "https://dashboard.example/setup" });
    expect(states.consume(state, "linkedin")).toBeUndefined();
    expect(states.consume(states.create("linkedin"), "linkedin")).toEqual({});
  });

  it("rejects a state issued for a different platform", () => {
    const states = createOAuthStates("state-secret");
    expect(states.consume(states.create("linkedin"), "facebook")).toBeUndefined();
  });

  it("rejects tampered, malformed or foreign state", () => {
    const states = createOAuthStates("state-secret");
    const state = states.create("linkedin", "https://dashboard.example/setup");
    const parts = state.split(".");
    expect(states.consume(`${state}x`, "linkedin")).toBeUndefined();
    expect(states.consume(state.replace(/^linkedin/, "facebook"), "facebook")).toBeUndefined();
    parts[3] = Buffer.from("https://attacker.example/").toString("base64url");
    expect(states.consume(parts.join("."), "linkedin")).toBeUndefined();
    expect(states.consume("not-a-state", "linkedin")).toBeUndefined();
    expect(createOAuthStates("other-secret").consume(state, "linkedin")).toBeUndefined();
  });

  it("expires state after ten minutes", () => {
    const states = createOAuthStates("state-secret");
    const issuedAt = Date.now();
    expect(states.consume(states.create("linkedin", undefined, issuedAt), "linkedin", issuedAt + 10 * 60_000)).toBeUndefined();
    expect(states.consume(states.create("linkedin", undefined, issuedAt), "linkedin", issuedAt + 9 * 60_000)).toEqual({});
  });
});
