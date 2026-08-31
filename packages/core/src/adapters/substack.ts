import { ApiAdapter } from "./base.js";
export const substack = new ApiAdapter("substack", { text: true, image: false, video: false, schedule: false, analytics: false }, false);
