import { randomUUID } from "node:crypto";
import { type Capabilities, type PlatformAdapter, type PlatformId, type PostDraft, type Profile, type TokenSet, type PublishResult, UnsupportedOperation } from "../types.js";

export class ApiAdapter implements PlatformAdapter {
  constructor(public readonly id: PlatformId, public readonly capabilities: Capabilities, private readonly supported = true) {}
  getAuthUrl(state: string): string { if (process.env.MOCK_MODE !== "true") throw new UnsupportedOperation(this.id, "OAuth"); return `https://auth.${this.id}.example/authorize?state=${encodeURIComponent(state)}`; }
  async exchangeCode(code: string): Promise<TokenSet> { return { accessToken: `mock-${this.id}-${code}`, expiresAt: new Date(Date.now() + 3_600_000) }; }
  async refreshToken(t: TokenSet): Promise<TokenSet> { return { ...t, expiresAt: new Date(Date.now() + 3_600_000) }; }
  async getProfile(): Promise<Profile> { return { id: `mock-${this.id}`, name: `Mock ${this.id}` }; }
  async publish(_t: TokenSet, post: PostDraft): Promise<PublishResult> {
    if (!this.supported) throw new UnsupportedOperation(this.id, "publishing");
    if (!post.text.trim()) throw new Error("Post text is required");
    if (process.env.MOCK_MODE !== "true") throw new UnsupportedOperation(this.id, "publishing until its API client is configured");
    return { platformPostId: `${this.id}-${randomUUID()}`, publishedAt: new Date() };
  }
}
