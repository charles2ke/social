import { ApiAdapter } from "./base.js";
export const tiktok = new ApiAdapter("tiktok", { text: true, image: false, video: true, schedule: true, analytics: true }, true, { maxAttachments: 1, allowsMixedKinds: false, requiresKind: "video" });
