/**
 * UI metadata for the platforms implemented in `@social/core`. The API stays
 * authoritative about capabilities (`GET /platforms`); this table only carries
 * what the browser needs to render labels, brand accents and setup guidance.
 */
export type PlatformMeta = {
  id: string;
  label: string;
  /** Brand accent used for the icon tile; kept subtle so themes stay consistent. */
  accent: string;
  summary: string;
  /** Environment variables that must be set before the platform can be connected. */
  env: string[];
  docs: string;
  /** Set when the platform cannot publish at all, explaining why. */
  unsupported?: string;
};

export const platforms: PlatformMeta[] = [
  {
    id: "instagram",
    label: "Instagram",
    accent: "#e1306c",
    summary: "Publishes a media container to a Business/Creator account. Media is required.",
    env: ["META_CLIENT_ID", "META_CLIENT_SECRET", "INSTAGRAM_PAGE_ID"],
    docs: "https://developers.facebook.com/docs/instagram-api/",
  },
  {
    id: "facebook",
    label: "Facebook",
    accent: "#1877f2",
    summary: "Posts to a Page feed, attaching a single image or video link.",
    env: ["META_CLIENT_ID", "META_CLIENT_SECRET", "FACEBOOK_PAGE_ID"],
    docs: "https://developers.facebook.com/docs/pages-api/",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    accent: "#25d366",
    summary: "Sends the text to opted-in recipients through the Cloud API — there is no broadcast post.",
    env: ["META_CLIENT_ID", "META_CLIENT_SECRET", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_RECIPIENTS"],
    docs: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    accent: "#0a66c2",
    summary: "Shares a member ugcPost. Member tokens are refreshed automatically.",
    env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    docs: "https://www.linkedin.com/developers/",
  },
  {
    id: "substack",
    label: "Substack",
    accent: "#ff6719",
    summary: "No public publishing API.",
    env: [],
    docs: "https://substack.com/",
    unsupported: "Substack exposes no public API for publishing, so this platform is read-only here.",
  },
  {
    id: "youtube",
    label: "YouTube",
    accent: "#ff0000",
    summary: "Resumable videos.insert upload. Requires exactly one video URL.",
    env: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_PRIVACY_STATUS"],
    docs: "https://developers.google.com/youtube/v3",
  },
  {
    id: "snapchat",
    label: "Snapchat",
    accent: "#f7c600",
    summary: "No public publishing API for organic content.",
    env: [],
    docs: "https://developers.snap.com/",
    unsupported: "Snapchat has no public API for publishing organic content, so publishing is unsupported.",
  },
  {
    id: "tiktok",
    label: "TikTok",
    accent: "#00f2ea",
    summary: "Pulls one video from a verified domain. Unaudited apps may only post privately.",
    env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_PRIVACY_LEVEL"],
    docs: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  },
  {
    id: "strava",
    label: "Strava",
    accent: "#fc4c02",
    summary: "Strava has no feed post, so a published draft becomes an activity.",
    env: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_SPORT_TYPE"],
    docs: "https://developers.strava.com/",
  },
];

export const platformIds = platforms.map((platform) => platform.id);

const byId = new Map(platforms.map((platform) => [platform.id, platform]));

export function platformMeta(id: string): PlatformMeta {
  return byId.get(id) ?? { id, label: id, accent: "#64748b", summary: "", env: [], docs: "" };
}
