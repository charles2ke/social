import { apiUrl } from "./config";
import type { MediaAttachment } from "./media";

/** Mirrors `StoredPost` in apps/api/src/posts.ts. */
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
export type PostAttempt = { platform: string; status: string; externalPostId?: string; error?: string };
/** Replaces the post's text or attachments on one platform; attachments given here replace the post's rather than adding to them. */
export type PlatformOverride = { text?: string; media?: MediaAttachment[] };
export type StoredPost = {
  id: string;
  text: string;
  media: MediaAttachment[];
  platforms: string[];
  /** Keyed by platform; omitted when no platform is customized. */
  perPlatformOverrides?: Record<string, PlatformOverride>;
  status: PostStatus;
  scheduledFor?: string;
  createdAt: string;
  lastError?: string;
  /** One entry per platform the post was sent to; `pending` means the outcome was never confirmed. */
  attempts?: PostAttempt[];
};
export type PublishResult = { platform: string; status: "published" | "failed"; url?: string; error?: string };
export type PublishNowResponse = { post: StoredPost; results: PublishResult[] };

/** Draft, scheduled and failed posts can still be edited, published or cancelled; the rest are in flight or done. */
export const isEditable = (status: PostStatus) => status === "draft" || status === "scheduled" || status === "failed";

export const statusMeta: Record<PostStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "" },
  scheduled: { label: "Scheduled", className: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300" },
  publishing: { label: "Publishing", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  published: { label: "Published", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
  failed: { label: "Failed", className: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" },
  cancelled: { label: "Cancelled", className: "opacity-70" },
};

export const attemptFor = (post: StoredPost, platform: string) => post.attempts?.find((attempt) => attempt.platform === platform);

/**
 * The platforms publishing now would send to. The API skips those that
 * already succeeded, and never resends one whose outcome is unconfirmed.
 */
export const remainingPlatforms = (post: StoredPost) =>
  post.platforms.filter((platform) => !["success", "pending"].includes(attemptFor(post, platform)?.status ?? ""));

/** A non-2xx API reply, carrying the API's message and, for a 409, the post as it currently is. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly post?: StoredPost,
  ) {
    super(message);
  }
}

/** Calls the API with an optional JSON body, throwing `ApiError` for an error reply. */
export async function callApi<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(`${apiUrl}${path}`, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    ...(hasBody ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    signal: init.signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = body as { error?: string; post?: StoredPost } | undefined;
    throw new ApiError(error?.error ?? `Request failed (${response.status})`, response.status, error?.post);
  }
  return body as T;
}

export const errorMessage = (error: unknown) => (error instanceof ApiError ? error.message : "Could not reach the API");
