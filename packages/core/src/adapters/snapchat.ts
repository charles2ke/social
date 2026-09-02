import type { PlatformSpec } from "./base.js";

/** Snapchat exposes no public API for publishing organic content. */
export const snapchatSpec: PlatformSpec = {
  id: "snapchat",
  capabilities: { text: false, image: false, video: false, schedule: false, analytics: false },
  publishUnsupported: "Snapchat has no public organic publishing API",
};
