import { ApiAdapter } from "./base.js";
// Instagram carousels accept up to 10 images/videos, mixed kinds allowed, and every post needs media.
export const instagram = new ApiAdapter("instagram", { text: true, image: true, video: true, schedule: true, analytics: true }, true, { maxAttachments: 10, allowsMixedKinds: true, requiresMedia: true });
