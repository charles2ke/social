import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/rate-limit.js";

describe("rate limiter", () => {
  it("allows up to the limit and then blocks within the window", () => {
    const allow = createRateLimiter(2, 60_000);
    expect(allow("1.2.3.4", 0)).toBe(true);
    expect(allow("1.2.3.4", 1)).toBe(true);
    expect(allow("1.2.3.4", 2)).toBe(false);
  });

  it("tracks callers independently", () => {
    const allow = createRateLimiter(1, 60_000);
    expect(allow("1.2.3.4", 0)).toBe(true);
    expect(allow("5.6.7.8", 0)).toBe(true);
    expect(allow("1.2.3.4", 0)).toBe(false);
  });

  it("resets once the window has passed", () => {
    const allow = createRateLimiter(1, 1_000);
    expect(allow("1.2.3.4", 0)).toBe(true);
    expect(allow("1.2.3.4", 500)).toBe(false);
    expect(allow("1.2.3.4", 1_500)).toBe(true);
  });
});
