export const platformIds = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"] as const;
export type PlatformId = (typeof platformIds)[number];
export type Capabilities = { text: boolean; image: boolean; video: boolean; schedule: boolean; analytics: boolean };
export const mediaKinds = ["image", "video"] as const;
export type MediaKind = (typeof mediaKinds)[number];
export type MediaAttachment = { url: string; kind: MediaKind; altText?: string };
/** Per-platform publishing limits for image/video attachments. */
export type MediaConstraints = { maxAttachments: number; allowsMixedKinds: boolean; requiresMedia?: boolean; requiresKind?: MediaKind };
/** Which part of the post text a platform field receives: all of it, its first line, or everything after the first line. */
export type TextPart = "text" | "firstLine" | "rest";
/** How a platform counts a text limit: Unicode characters (code points), UTF-16 code units, or UTF-8 bytes. */
export type TextUnit = "characters" | "utf16" | "bytes";
/** A documented length limit on a platform field filled from the post text. */
export type TextLimit = {
  /** The platform's name for the field, used in messages ("caption", "title"…). */
  field: string;
  part: TextPart;
  max: number;
  unit: TextUnit;
  /** Characters the platform rejects in this field. */
  disallowed?: string[];
};
/** Replaces parts of a post on one platform. Attachments given here replace the post's rather than adding to them. */
export type PlatformOverride = { text?: string; mediaUrls?: string[]; media?: MediaAttachment[] };
export type PlatformOverrides = Partial<Record<PlatformId, PlatformOverride>>;
/** `externalId` is the platform-side account id (page id, IG user id, LinkedIn URN…) resolved at connect time; publishing endpoints are scoped to it. */
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: Date; externalId?: string };
export type Profile = { id: string; name: string; avatarUrl?: string };
export type PostDraft = { id?: string; text: string; mediaUrls?: string[]; media?: MediaAttachment[]; perPlatformOverrides?: PlatformOverrides };
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
  textLimits: TextLimit[];
  /** Why the platform cannot publish at all, when it has no public publishing API. */
  publishUnsupported?: string;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(t: TokenSet): Promise<TokenSet>;
  getProfile(t: TokenSet): Promise<Profile>;
  publish(t: TokenSet, post: PostDraft): Promise<PublishResult>;
  getAnalytics?(t: TokenSet, ref: PostRef): Promise<Metrics>;
}
