export type MediaKind = "image" | "video";
export type MediaAttachment = { url: string; kind: MediaKind; altText?: string };

const extensions: Record<MediaKind, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif"],
  video: ["mp4", "mov", "m4v", "webm", "mpeg"]
};

/** Mirror of `@social/core`'s inference so the composer can pre-select a kind; the API stays authoritative. */
export function inferMediaKind(url: string): MediaKind | undefined {
  const extension = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].includes(extension));
}

/** Only http(s) media can be fetched by a platform, so refuse anything else up front. */
export function isHttpUrl(url: string): boolean {
  try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
}

/** Return an http(s)-only src for previews so a hostile URL can never become `javascript:` or `data:`. */
export function safeMediaSrc(url: string): string {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : ""; } catch { return ""; }
}
