import { requireExternalId, type PlatformSpec } from "./base.js";
import { GRAPH_API, insightValue, metaOAuth, type GraphInsights } from "./meta.js";

/** Publishes to a Facebook Page feed via the Graph API. */
export const facebookSpec: PlatformSpec = {
  id: "facebook",
  capabilities: { text: true, image: true, video: true, schedule: true, analytics: true },
  oauth: metaOAuth(["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights"]),
  async getProfile(ctx) {
    const me = await ctx.request<{ id: string; name: string }>(`${GRAPH_API}/me?fields=id,name`);
    return { id: me.id, name: me.name };
  },
  async publish(ctx, post) {
    const pageId = requireExternalId(ctx);
    const link = post.mediaUrls?.[0];
    const created = await ctx.request<{ id: string }>(`${GRAPH_API}/${encodeURIComponent(pageId)}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: post.text, ...(link ? { link } : {}) }),
    });
    return { platformPostId: created.id, url: `https://www.facebook.com/${created.id}`, publishedAt: new Date() };
  },
  async getAnalytics(ctx, ref) {
    const id = encodeURIComponent(ref.platformPostId);
    const [insights, summary] = await Promise.all([
      ctx.request<GraphInsights>(`${GRAPH_API}/${id}/insights?metric=post_impressions,post_engaged_users`),
      ctx.request<{ likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
        `${GRAPH_API}/${id}?fields=likes.summary(true),comments.summary(true)`,
      ),
    ]);
    return {
      impressions: insightValue(insights, "post_impressions"),
      engagements: insightValue(insights, "post_engaged_users"),
      likes: summary.likes?.summary?.total_count,
      comments: summary.comments?.summary?.total_count,
    };
  },
};
