export const platformIds = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"] as const;
export type PlatformId = (typeof platformIds)[number];
export type Capabilities = { text: boolean; image: boolean; video: boolean; schedule: boolean; analytics: boolean };
export const mediaKinds = ["image", "video"] as const;
export type MediaKind = (typeof mediaKinds)[number];
export type MediaAttachment = { url: string; kind: MediaKind; altText?: string };
/** Per-platform publishing limits for image/video attachments. */
export type MediaConstraints = { maxAttachments: number; allowsMixedKinds: boolean; requiresMedia?: boolean; requiresKind?: MediaKind };
/**
 * Per-platform text limits in characters (UTF-16 code units). When
 * `titleMaxLength` is set the platform publishes the first line as a title,
 * and `maxLength` applies to the rest of the text.
 */
export type TextConstraints = { maxLength?: number; titleMaxLength?: number };
/** `externalId` is the platform-side account id (page id, IG user id, LinkedIn URN…) resolved at connect time; publishing endpoints are scoped to it. */
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: Date; externalId?: string };
export type Profile = { id: string; name: string; avatarUrl?: string };
export type PostDraft = { id?: string; text: string; mediaUrls?: string[]; media?: MediaAttachment[]; perPlatformOverrides?: Record<string, Partial<PostDraft>> };
/** Text that replaces a post's main text on one platform. */
export type PlatformOverride = { text: string };
export type PlatformOverrides = Partial<Record<PlatformId, PlatformOverride>>;
export type PublishResult = { platformPostId: string; url?: string; publishedAt: Date };
export type PostRef = { platformPostId: string };
export type Metrics = { impressions?: number; engagements?: number; likes?: number; comments?: number };
export class UnsupportedOperation extends Error {
  constructor(public readonly platform: PlatformId, operation: string, reason?: string) {
    super(reason ?? `${platform} does not support ${operation} through its public API`);
    this.name = "UnsupportedOperation";
  }
}
export class MediaValidationError extends Error {
  constructor(message: string, public readonly platform?: PlatformId) {
    super(message);
    this.name = "MediaValidationError";
  }
}
export class TextValidationError extends Error {
  constructor(message: string, public readonly platform?: PlatformId) {
    super(message);
    this.name = "TextValidationError";
  }
}
export interface PlatformAdapter {
  id: PlatformId;
  capabilities: Capabilities;
  mediaConstraints: MediaConstraints;
  textConstraints?: TextConstraints;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(t: TokenSet): Promise<TokenSet>;
  getProfile(t: TokenSet): Promise<Profile>;
  publish(t: TokenSet, post: PostDraft): Promise<PublishResult>;
  getAnalytics?(t: TokenSet, ref: PostRef): Promise<Metrics>;
}
