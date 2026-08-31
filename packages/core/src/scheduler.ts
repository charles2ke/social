import type { PostDraft, PlatformId, PublishResult } from "./types.js";
export type ScheduledPost = { id: string; draft: PostDraft; platforms: PlatformId[]; scheduledFor: Date; cancelled?: boolean; results?: Record<string, PublishResult | Error> };
export async function publishDue(posts: ScheduledPost[], now: Date, publish: (platform: PlatformId, draft: PostDraft) => Promise<PublishResult>) {
  return Promise.all(posts.filter((post) => !post.cancelled && !post.results && post.scheduledFor <= now).map(async (post) => {
    post.results = {};
    await Promise.all(post.platforms.map(async (platform) => { try { post.results![platform] = await publish(platform, post.draft); } catch (error) { post.results![platform] = error instanceof Error ? error : new Error("Publishing failed"); } }));
    return post;
  }));
}
