import { ApiAdapter } from "./base.js";
// LinkedIn posts carry up to 9 images or a single video, never both.
export const linkedin = new ApiAdapter("linkedin", { text: true, image: true, video: true, schedule: true, analytics: true }, true, { maxAttachments: 9, allowsMixedKinds: false });
