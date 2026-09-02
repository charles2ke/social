import { type MediaAttachment, type MediaConstraints, type MediaKind, type PlatformId, type PostDraft, MediaValidationError } from "./types.js";

const extensions: Record<MediaKind, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif"],
  video: ["mp4", "mov", "m4v", "webm", "mpeg"]
};

/** Infer whether a media URL points at an image or a video from its extension. */
export function inferMediaKind(url: string): MediaKind | undefined {
  const extension = url.split(/[?#]/, 1)[0]!.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].includes(extension));
}

/** Merge a draft's `media` list and legacy `mediaUrls` into typed attachments, keeping the first entry per URL. */
export function normalizeMedia(draft: Pick<PostDraft, "media" | "mediaUrls">): MediaAttachment[] {
  const attachments = [...(draft.media ?? []), ...(draft.mediaUrls ?? []).map((url) => ({ url, kind: inferMediaKind(url) }))];
  const seen = new Map<string, MediaAttachment>();
  for (const attachment of attachments) {
    const kind = attachment.kind ?? inferMediaKind(attachment.url);
    if (!kind) throw new MediaValidationError(`Cannot determine whether ${attachment.url} is an image or a video — set "kind" explicitly`);
    if (!seen.has(attachment.url)) seen.set(attachment.url, { ...attachment, kind });
  }
  return [...seen.values()];
}

function assertUsableUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new MediaValidationError(`Media URL is not a valid URL: ${url}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new MediaValidationError(`Media URL must use http(s): ${url}`);
}

/** Validate attachments against a platform's declared image/video support and limits. */
export function validateMedia(platform: PlatformId, capabilities: { image: boolean; video: boolean; text: boolean }, constraints: MediaConstraints, media: MediaAttachment[]) {
  for (const attachment of media) {
    assertUsableUrl(attachment.url);
    if (!capabilities[attachment.kind]) throw new MediaValidationError(`${platform} does not support ${attachment.kind} attachments`, platform);
  }
  if (media.length > constraints.maxAttachments) throw new MediaValidationError(`${platform} accepts at most ${constraints.maxAttachments} attachment(s), received ${media.length}`, platform);
  if (!constraints.allowsMixedKinds && new Set(media.map((attachment) => attachment.kind)).size > 1) throw new MediaValidationError(`${platform} cannot mix images and videos in one post`, platform);
  if ((constraints.requiresMedia || constraints.requiresKind) && !media.length) throw new MediaValidationError(`${platform} requires at least one image or video attachment`, platform);
  if (constraints.requiresKind && !media.some((attachment) => attachment.kind === constraints.requiresKind)) throw new MediaValidationError(`${platform} requires a ${constraints.requiresKind} attachment`, platform);
}
