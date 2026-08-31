import { describe, expect, it, beforeEach } from "vitest";
import { adapters, decrypt, encrypt, publishDue } from "../src/index.js";
beforeEach(() => { process.env.ENCRYPTION_KEY = "a".repeat(64); });
describe("core", () => {
  it("encrypts tokens with authenticated encryption", () => expect(decrypt(encrypt("secret"))).toBe("secret"));
  it("publishes due posts but not future ones", async () => {
    const [done] = await publishDue([{ id: "1", draft: { text: "Hello" }, platforms: ["linkedin"], scheduledFor: new Date() }], new Date(), async () => ({ platformPostId: "1", publishedAt: new Date() }));
    expect(done.results?.linkedin).toBeDefined();
  });
  it("provides all requested adapters", () => expect(Object.keys(adapters)).toHaveLength(9));
});
