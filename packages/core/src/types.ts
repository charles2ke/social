export const platformIds = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"] as const;
export type PlatformId = (typeof platformIds)[number];
export type Capabilities = { text: boolean; image: boolean; video: boolean; schedule: boolean; analytics: boolean };
/** `externalId` is the platform-side account id (page id, IG user id, LinkedIn URN…) resolved at connect time; publishing endpoints are scoped to it. */
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: Date; externalId?: string };
export type Profile = { id: string; name: string; avatarUrl?: string };
export type PostDraft = { id?: string; text: string; mediaUrls?: string[]; perPlatformOverrides?: Record<string, Partial<PostDraft>> };
export type PublishResult = { platformPostId: string; url?: string; publishedAt: Date };
export type PostRef = { platformPostId: string };
export type Metrics = { impressions?: number; engagements?: number; likes?: number; comments?: number };
export class UnsupportedOperation extends Error {
  constructor(public readonly platform: PlatformId, operation: string) {
    super(`${platform} does not support ${operation} through its public API`);
    this.name = "UnsupportedOperation";
  }
}
export interface PlatformAdapter {
  id: PlatformId;
  capabilities: Capabilities;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refreshToken(t: TokenSet): Promise<TokenSet>;
  getProfile(t: TokenSet): Promise<Profile>;
  publish(t: TokenSet, post: PostDraft): Promise<PublishResult>;
  getAnalytics?(t: TokenSet, ref: PostRef): Promise<Metrics>;
}
