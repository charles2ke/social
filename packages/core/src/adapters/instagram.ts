import { requireExternalId, type PlatformSpec } from "./base.js";
import { GRAPH_API, insightValue, metaOAuth, type GraphInsights } from "./meta.js";

const isVideo = (url: string) => /\.(mp4|mov|m4v)(\?|$)/i.test(url);

/**
 * Instagram publishing is a two-step Graph API flow: create a media container,
 * then publish it. The API has no text-only post type, so media is required.
 */
export const instagramSpec: PlatformSpec = {
  id: "instagram",
  capabilities: { text: true, image: true, video: true, schedule: true, analytics: true },
  oauth: metaOAuth(["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list"]),
  async getProfile(ctx) {
    const me = await ctx.request<{ id: string; username?: string }>(`${GRAPH_API}/me?fields=id,username`);
    return { id: me.id, name: me.username ?? me.id };
  },
  async publish(ctx, post) {
    const userId = encodeURIComponent(requireExternalId(ctx));
    const media = post.mediaUrls?.[0];
    if (!media) throw new Error("Instagram requires an image or video URL — its API has no text-only post type");
    const container = await ctx.request<{ id: string }>(`${GRAPH_API}/${userId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption: post.text,
        ...(isVideo(media) ? { video_url: media, media_type: "REELS" } : { image_url: media }),
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
