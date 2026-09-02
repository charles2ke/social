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
    // The publishing endpoints are scoped to the Instagram user id linked to a Page,
    // which is not the Graph /me id of the user who authorized the app.
    const pages = await ctx.request<{ data?: { id: string; instagram_business_account?: { id: string; username?: string } }[] }>(
      `${GRAPH_API}/me/accounts?fields=instagram_business_account{id,username}`,
    );
    const preferred = ctx.env.INSTAGRAM_PAGE_ID;
    const linked = (pages.data ?? []).filter((page) => page.instagram_business_account);
    const page = preferred ? linked.find((candidate) => candidate.id === preferred) : linked[0];
    const account = page?.instagram_business_account;
    if (!account) {
      throw new Error(
        preferred
          ? `Facebook Page ${preferred} has no linked Instagram Business account`
          : "No Instagram Business account is linked to the authorized Facebook Page(s) — publishing requires one",
      );
    }
    return { id: account.id, name: account.username ?? account.id };
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
