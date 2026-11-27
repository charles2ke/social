import { type MediaAttachment, type MediaConstraints, type MediaKind, mediaKinds, type PlatformId, type PostDraft, MediaValidationError } from "./types.js";

const extensions: Record<MediaKind, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif"],
  video: ["mp4", "mov", "m4v", "webm", "mpeg"]
};

/** Bounds every draft must respect whatever its platforms; the most generous platform takes 10 attachments. */
export const mediaLimits = { maxAttachments: 20, maxUrlLength: 2048, maxAltTextLength: 1000 } as const;

const isMediaKind = (value: unknown): value is MediaKind => typeof value === "string" && (mediaKinds as readonly string[]).includes(value);

/** Infer whether a media URL points at an image or a video from its extension. */
export function inferMediaKind(url: string): MediaKind | undefined {
  const extension = url.split(/[?#]/, 1)[0]!.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].includes(extension));
}

function assertUsableUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || !url) throw new MediaValidationError("Media URLs must be non-empty strings");
  if (url.length > mediaLimits.maxUrlLength) throw new MediaValidationError(`Media URLs are limited to ${mediaLimits.maxUrlLength} characters`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new MediaValidationError(`Media URL is not a valid URL: ${url}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new MediaValidationError(`Media URL must use http(s): ${url}`);
  // Not echoed: the URL carries a password.
  if (parsed.username || parsed.password) throw new MediaValidationError("Media URLs must not contain credentials");
}

type RawAttachment = { url?: unknown; kind?: unknown; altText?: unknown };

/**
 * Merge a draft's `media` list and legacy `mediaUrls` into typed attachments,
 * keeping the first entry per URL. Drafts arrive straight from request bodies,
 * so every field is checked at runtime and unknown properties are dropped.
 */
export function normalizeMedia(draft: Pick<PostDraft, "media" | "mediaUrls">): MediaAttachment[] {
  const { media = [], mediaUrls = [] } = draft as { media?: unknown; mediaUrls?: unknown };
  if (!Array.isArray(media)) throw new MediaValidationError("media must be an array");
  if (!Array.isArray(mediaUrls)) throw new MediaValidationError("mediaUrls must be an array");
  if (media.length + mediaUrls.length > mediaLimits.maxAttachments) throw new MediaValidationError(`A post can have at most ${mediaLimits.maxAttachments} attachments`);
  const attachments: RawAttachment[] = [
    ...media.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new MediaValidationError("Each media entry must be an object with a url");
      return entry as RawAttachment;
    }),
    ...mediaUrls.map((url: unknown) => ({ url })),
  ];
  const seen = new Map<string, MediaAttachment>();
  for (const { url, kind: declaredKind, altText } of attachments) {
    assertUsableUrl(url);
    if (declaredKind != null && !isMediaKind(declaredKind)) throw new MediaValidationError('Media kind must be "image" or "video"');
    const kind = declaredKind ?? inferMediaKind(url);
    if (!kind) throw new MediaValidationError(`Cannot determine whether ${url} is an image or a video — set "kind" explicitly`);
    if (altText != null && (typeof altText !== "string" || altText.length > mediaLimits.maxAltTextLength)) {
      throw new MediaValidationError(`altText must be a string of at most ${mediaLimits.maxAltTextLength} characters`);
    }
    if (!seen.has(url)) seen.set(url, { url, kind, ...(altText ? { altText } : {}) });
  }
  return [...seen.values()];
}

/** Validate attachments against a platform's declared image/video support and limits. */
export function validateMedia(platform: PlatformId, capabilities: { image: boolean; video: boolean; text: boolean }, constraints: MediaConstraints, media: MediaAttachment[]) {
  for (const attachment of media) {
    assertUsableUrl(attachment.url);
    if (!isMediaKind(attachment.kind) || !capabilities[attachment.kind]) throw new MediaValidationError(`${platform} does not support ${attachment.kind} attachments`, platform);
  }
  if (media.length > constraints.maxAttachments) throw new MediaValidationError(`${platform} accepts at most ${constraints.maxAttachments} attachment(s), received ${media.length}`, platform);
  if (!constraints.allowsMixedKinds && new Set(media.map((attachment) => attachment.kind)).size > 1) throw new MediaValidationError(`${platform} cannot mix images and videos in one post`, platform);
  if ((constraints.requiresMedia || constraints.requiresKind) && !media.length) throw new MediaValidationError(`${platform} requires at least one image or video attachment`, platform);
  if (constraints.requiresKind && !media.some((attachment) => attachment.kind === constraints.requiresKind)) throw new MediaValidationError(`${platform} requires a ${constraints.requiresKind} attachment`, platform);
}
