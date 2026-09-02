import { randomUUID } from "node:crypto";
import { normalizeMedia, validateMedia } from "../media.js";
import { type Capabilities, type MediaConstraints, type PlatformAdapter, type PlatformId, type PostDraft, type Profile, type TokenSet, type PublishResult, UnsupportedOperation } from "../types.js";

const noMedia: MediaConstraints = { maxAttachments: 0, allowsMixedKinds: false };

export class ApiAdapter implements PlatformAdapter {
  constructor(public readonly id: PlatformId, public readonly capabilities: Capabilities, private readonly supported = true, public readonly mediaConstraints: MediaConstraints = noMedia) {}
  getAuthUrl(state: string): string { if (process.env.MOCK_MODE !== "true") throw new UnsupportedOperation(this.id, "OAuth"); return `https://auth.${this.id}.example/authorize?state=${encodeURIComponent(state)}`; }
  async exchangeCode(code: string): Promise<TokenSet> { return { accessToken: `mock-${this.id}-${code}`, expiresAt: new Date(Date.now() + 3_600_000) }; }
  async refreshToken(t: TokenSet): Promise<TokenSet> { return { ...t, expiresAt: new Date(Date.now() + 3_600_000) }; }
  async getProfile(): Promise<Profile> { return { id: `mock-${this.id}`, name: `Mock ${this.id}` }; }
  async publish(_t: TokenSet, post: PostDraft): Promise<PublishResult> {
    if (!this.supported) throw new UnsupportedOperation(this.id, "publishing");
    const media = normalizeMedia(post);
    if (!post.text.trim() && !media.length) throw new Error("Post text is required");
    validateMedia(this.id, this.capabilities, this.mediaConstraints, media);
    if (process.env.MOCK_MODE !== "true") throw new UnsupportedOperation(this.id, "publishing until its API client is configured");
    return { platformPostId: `${this.id}-${randomUUID()}`, publishedAt: new Date() };
  }
}
