import type { PlatformSpec } from "./base.js";

/** Substack has no documented public write API. */
export const substackSpec: PlatformSpec = {
  id: "substack",
  capabilities: { text: true, image: false, video: false, schedule: false, analytics: false },
  publishUnsupported: "Substack has no public publishing API",
};
