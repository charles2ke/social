import { beforeEach, describe, expect, it } from "vitest";
import { createState, verifyState } from "../src/oauth-state.js";

describe("oauth state", () => {
  beforeEach(() => {
    process.env.OAUTH_STATE_SECRET = "state-secret";
  });

  it("round-trips a state value for the platform that issued it", () => {
    const state = createState("linkedin");
    expect(verifyState(state, "linkedin")).toBe(true);
  });

  it("rejects a state issued for a different platform", () => {
    expect(verifyState(createState("linkedin"), "facebook")).toBe(false);
  });

  it("rejects tampered or malformed state", () => {
    const state = createState("linkedin");
    expect(verifyState(`${state}x`, "linkedin")).toBe(false);
    expect(verifyState(state.replace(/^linkedin/, "facebook"), "facebook")).toBe(false);
    expect(verifyState("not-a-state", "linkedin")).toBe(false);
  });

  it("rejects state signed with a different secret", () => {
    const state = createState("linkedin");
    process.env.OAUTH_STATE_SECRET = "other-secret";
    expect(verifyState(state, "linkedin")).toBe(false);
  });

  it("expires state after ten minutes", () => {
    const state = createState("linkedin");
    expect(verifyState(state, "linkedin", Date.now() + 11 * 60_000)).toBe(false);
  });
});
