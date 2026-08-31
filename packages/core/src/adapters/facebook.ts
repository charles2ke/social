import { ApiAdapter } from "./base.js";
export const facebook = new ApiAdapter("facebook", { text: true, image: true, video: true, schedule: true, analytics: true });
