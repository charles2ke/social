import { normalizeMedia, validateMedia } from "./media.js";
import { measureText, textProblems, type TextUsage } from "./text.js";
import type { MediaAttachment, PlatformAdapter, PlatformId, PostDraft } from "./types.js";

/**
 * The draft one platform publishes: the post with that platform's override
 * applied. Only the fields an override sets replace the post's, and its
 * attachments replace the post's attachments rather than adding to them.
 */
export function draftFor(platform: PlatformId, post: PostDraft): PostDraft {
  const override = post.perPlatformOverrides?.[platform];
  if (!override) return post;
  const replacesMedia = override.media !== undefined || override.mediaUrls !== undefined;
  return {
    ...post,
    ...(override.text !== undefined ? { text: override.text } : {}),
    ...(replacesMedia ? { media: override.media ?? [], mediaUrls: override.mediaUrls ?? [] } : {}),
  };
}

export type DraftCheck = {
  platform: PlatformId;
  ok: boolean;
  /** Everything that would make publishing to this platform fail. */
  problems: string[];
  /** How much of each of the platform's text limits the post uses. */
  text: TextUsage[];
};

/** Checks `post` against what `adapter` would enforce when publishing it, without publishing anything. */
export function checkDraft(
  adapter: Pick<PlatformAdapter, "id" | "capabilities" | "mediaConstraints" | "textLimits" | "publishUnsupported">,
  post: PostDraft,
): DraftCheck {
  const draft = draftFor(adapter.id, post);
  const problems: string[] = adapter.publishUnsupported ? [adapter.publishUnsupported] : [];
  let media: MediaAttachment[] = [];
  try {
    media = normalizeMedia(draft);
    validateMedia(adapter.id, adapter.capabilities, adapter.mediaConstraints, media);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "Invalid media");
  }
  if (!draft.text.trim() && !media.length) problems.push("Post text is required");
  problems.push(...textProblems(adapter.id, adapter.textLimits, draft.text));
  return { platform: adapter.id, ok: problems.length === 0, problems, text: measureText(adapter.textLimits, draft.text) };
}
