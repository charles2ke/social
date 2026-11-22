import { PlatformApiError } from "../http.js";
import type { PlatformSpec } from "./base.js";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Default cap on a video downloaded for upload; `MEDIA_MAX_DOWNLOAD_BYTES` overrides it. */
const DEFAULT_MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const uploadableType = /^(video\/|application\/octet-stream|binary\/octet-stream)/i;

/**
 * YouTube uploads are binary, so they bypass the JSON helper and call `fetch` directly.
 * The video is downloaded into memory (public addresses only, capped at
 * `MEDIA_MAX_DOWNLOAD_BYTES`) before being sent.
 */
export const youtubeSpec: PlatformSpec = {
  id: "youtube",
  capabilities: { text: true, image: false, video: true, schedule: true, analytics: true },
  // videos.insert uploads exactly one video; thumbnails are set separately.
  mediaConstraints: { maxAttachments: 1, allowsMixedKinds: false, requiresKind: "video" },
  textConstraints: { titleMaxLength: 100, maxLength: 5000 },
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    clientIdEnv: "YOUTUBE_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_CLIENT_SECRET",
    refreshable: true,
    // Google only returns a refresh token when offline access is re-consented.
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  async getProfile(ctx) {
    const channels = await ctx.request<{ items?: { id: string; snippet?: { title?: string } }[] }>(
      `${API}/channels?part=snippet&mine=true`,
    );
    const channel = channels.items?.[0];
    if (!channel) throw new Error("The connected Google account has no YouTube channel");
    return { id: channel.id, name: channel.snippet?.title ?? channel.id };
  },
  async publish(ctx, post) {
    const source = post.media[0]?.url;
    if (!source) throw new Error("YouTube requires a video URL to upload");
    const maxBytes = Number.parseInt(ctx.env.MEDIA_MAX_DOWNLOAD_BYTES ?? "", 10);
    const file = await ctx.download(source, { maxBytes: maxBytes > 0 ? maxBytes : DEFAULT_MAX_VIDEO_BYTES });
    if (file.contentType && !uploadableType.test(file.contentType)) {
      throw new Error(`The media to upload is not a video (content-type ${file.contentType.slice(0, 100)})`);
    }
    const authorization = ["Bearer", ctx.token.accessToken].join(" ");
    const [title, ...rest] = post.text.split("\n");
    const start = await ctx.fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", "X-Upload-Content-Type": "video/*" },
      body: JSON.stringify({
        snippet: { title: title.slice(0, 100), description: rest.join("\n") },
        status: { privacyStatus: ctx.env.YOUTUBE_PRIVACY_STATUS ?? "private" },
      }),
    });
    if (!start.ok) throw new PlatformApiError("youtube", start.status, await start.text());
    const session = start.headers.get("location");
    if (!session) throw new Error("YouTube did not return a resumable upload session");

    const upload = await ctx.fetch(session, {
      method: "PUT",
      headers: { Authorization: authorization, "Content-Type": file.contentType ?? "video/*" },
      body: file.bytes,
    });
    const body = await upload.text();
    if (!upload.ok) throw new PlatformApiError("youtube", upload.status, body);
    const video = JSON.parse(body) as { id?: string };
    if (!video.id) throw new Error("YouTube did not return a video id");
    return { platformPostId: video.id, url: `https://www.youtube.com/watch?v=${video.id}`, publishedAt: new Date() };
  },
  async getAnalytics(ctx, ref) {
    const videos = await ctx.request<{
      items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
    }>(`${API}/videos?part=statistics&id=${encodeURIComponent(ref.platformPostId)}`);
    const stats = videos.items?.[0]?.statistics ?? {};
    const count = (value?: string) => (value === undefined ? undefined : Number(value));
    return { impressions: count(stats.viewCount), likes: count(stats.likeCount), comments: count(stats.commentCount) };
  },
};
