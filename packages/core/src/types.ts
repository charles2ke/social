export const platformIds = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"] as const;
export type PlatformId = (typeof platformIds)[number];
export type Capabilities = { text: boolean; image: boolean; video: boolean; schedule: boolean; analytics: boolean };
export const mediaKinds = ["image", "video"] as const;
export type MediaKind = (typeof mediaKinds)[number];
export type MediaAttachment = { url: string; kind: MediaKind; altText?: string };
/** Per-platform publishing limits for image/video attachments. */
export type MediaConstraints = { maxAttachments: number; allowsMixedKinds: boolean; requiresMedia?: boolean; requiresKind?: MediaKind };
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: Date };
export type Profile = { id: string; name: string; avatarUrl?: string };
export type PostDraft = { id?: string; text: string; mediaUrls?: string[]; media?: MediaAttachment[]; perPlatformOverrides?: Record<string, Partial<PostDraft>> };
export type PublishResult = { platformPostId: string; url?: string; publishedAt: Date };
export type PostRef = { platformPostId: string };
export type Metrics = { impressions?: number; engagements?: number; likes?: number; comments?: number };
export class UnsupportedOperation extends Error {
  constructor(public readonly platform: PlatformId, operation: string) {
    super(`${platform} does not support ${operation} through its public API`);
    this.name = "UnsupportedOperation";
  }
}
export class MediaValidationError extends Error {
  constructor(message: string, public readonly platform?: PlatformId) {
    super(message);
    this.name = "MediaValidationError";
  }
}
export interface PlatformAdapter {
  id: PlatformId;
  capabilities: Capabilities;
  mediaConstraints: MediaConstraints;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(t: TokenSet): Promise<TokenSet>;
  getProfile(t: TokenSet): Promise<Profile>;
  publish(t: TokenSet, post: PostDraft): Promise<PublishResult>;
  getAnalytics?(t: TokenSet, ref: PostRef): Promise<Metrics>;
}
