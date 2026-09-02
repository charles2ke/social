import { ApiAdapter } from "./base.js";
// videos.insert uploads exactly one video; thumbnails are set separately.
export const youtube = new ApiAdapter("youtube", { text: true, image: false, video: true, schedule: true, analytics: true }, true, { maxAttachments: 1, allowsMixedKinds: false, requiresKind: "video" });
