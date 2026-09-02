import type { PlatformSpec } from "./base.js";

const API = "https://open.tiktokapis.com/v2";

/**
 * TikTok's Content Posting API pulls the video from a URL hosted on a verified
 * domain. Unaudited apps may only post privately, hence the SELF_ONLY default.
 */
export const tiktokSpec: PlatformSpec = {
  id: "tiktok",
  capabilities: { text: true, image: false, video: true, schedule: true, analytics: true },
  oauth: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: `${API}/oauth/token/`,
    scopes: ["user.info.basic", "video.publish", "video.list"],
    clientIdEnv: "TIKTOK_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_CLIENT_SECRET",
    refreshable: true,
    clientIdParam: "client_key",
  },
  async getProfile(ctx) {
    const info = await ctx.request<{ data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } } }>(
      `${API}/user/info/?fields=open_id,display_name,avatar_url`,
    );
    const user = info.data?.user;
    if (!user?.open_id) throw new Error("TikTok did not return a user profile");
    return { id: user.open_id, name: user.display_name ?? user.open_id, avatarUrl: user.avatar_url };
  },
  async publish(ctx, post) {
    const video = post.mediaUrls?.[0];
    if (!video) throw new Error("TikTok requires a video URL to publish");
    const initialised = await ctx.request<{ data?: { publish_id?: string } }>(`${API}/post/publish/video/init/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: post.text.slice(0, 2200),
          privacy_level: ctx.env.TIKTOK_PRIVACY_LEVEL ?? "SELF_ONLY",
        },
        source_info: { source: "PULL_FROM_URL", video_url: video },
      }),
    });
    const publishId = initialised.data?.publish_id;
    if (!publishId) throw new Error("TikTok did not return a publish id");
    return { platformPostId: publishId, publishedAt: new Date() };
  },
  async getAnalytics(ctx, ref) {
    const result = await ctx.request<{
      data?: { videos?: { like_count?: number; comment_count?: number; view_count?: number }[] };
    }>(`${API}/video/query/?fields=id,like_count,comment_count,view_count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { video_ids: [ref.platformPostId] } }),
    });
    const video = result.data?.videos?.[0] ?? {};
    return { impressions: video.view_count, likes: video.like_count, comments: video.comment_count };
  },
};
