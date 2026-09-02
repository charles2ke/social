import { requireExternalId, type PlatformSpec } from "./base.js";
import { GRAPH_API, insightValue, metaOAuth, type GraphInsights } from "./meta.js";

/**
 * Instagram publishing is a two-step Graph API flow: create a media container,
 * then publish it. The API has no text-only post type, so media is required.
 */
export const instagramSpec: PlatformSpec = {
  id: "instagram",
  capabilities: { text: true, image: true, video: true, schedule: true, analytics: true },
  // Carousels accept up to 10 images/videos, mixed kinds allowed, and every post needs media.
  mediaConstraints: { maxAttachments: 10, allowsMixedKinds: true, requiresMedia: true },
  oauth: metaOAuth(["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list"]),
  async getProfile(ctx) {
    const me = await ctx.request<{ id: string; username?: string }>(`${GRAPH_API}/me?fields=id,username`);
    return { id: me.id, name: me.username ?? me.id };
  },
  async publish(ctx, post) {
    const userId = encodeURIComponent(requireExternalId(ctx));
    const media = post.media[0];
    if (!media) throw new Error("Instagram requires an image or video URL — its API has no text-only post type");
    const container = await ctx.request<{ id: string }>(`${GRAPH_API}/${userId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption: post.text,
        ...(media.kind === "video" ? { video_url: media.url, media_type: "REELS" } : { image_url: media.url }),
      }),
    });
    const published = await ctx.request<{ id: string }>(`${GRAPH_API}/${userId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id }),
    });
    return { platformPostId: published.id, publishedAt: new Date() };
  },
  async getAnalytics(ctx, ref) {
    const id = encodeURIComponent(ref.platformPostId);
    const [insights, counts] = await Promise.all([
      ctx.request<GraphInsights>(`${GRAPH_API}/${id}/insights?metric=impressions,engagement`),
      ctx.request<{ like_count?: number; comments_count?: number }>(`${GRAPH_API}/${id}?fields=like_count,comments_count`),
    ]);
    return {
      impressions: insightValue(insights, "impressions"),
      engagements: insightValue(insights, "engagement"),
      likes: counts.like_count,
      comments: counts.comments_count,
    };
  },
};
