import { requireExternalId, type PlatformSpec } from "./base.js";

const API = "https://api.linkedin.com";

/** LinkedIn member posting via UGC Posts; analytics is limited to social actions. */
export const linkedinSpec: PlatformSpec = {
  id: "linkedin",
  capabilities: { text: true, image: true, video: true, schedule: true, analytics: true },
  oauth: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    refreshable: true,
  },
  async getProfile(ctx) {
    const me = await ctx.request<{ sub: string; name?: string; picture?: string }>(`${API}/v2/userinfo`);
    return { id: me.sub, name: me.name ?? me.sub, avatarUrl: me.picture };
  },
  async publish(ctx, post) {
    const author = `urn:li:person:${requireExternalId(ctx)}`;
    const created = await ctx.request<{ id: string }>(`${API}/v2/ugcPosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: post.text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    return {
      platformPostId: created.id,
      url: `https://www.linkedin.com/feed/update/${created.id}`,
      publishedAt: new Date(),
    };
  },
  async getAnalytics(ctx, ref) {
    const actions = await ctx.request<{
      likesSummary?: { totalLikes?: number };
      commentsSummary?: { totalFirstLevelComments?: number };
    }>(`${API}/v2/socialActions/${encodeURIComponent(ref.platformPostId)}`);
    return {
      likes: actions.likesSummary?.totalLikes,
      comments: actions.commentsSummary?.totalFirstLevelComments,
    };
  },
};
