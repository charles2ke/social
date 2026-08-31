import { ApiAdapter } from "./base.js";
export const strava = new ApiAdapter("strava", { text: true, image: false, video: false, schedule: true, analytics: false });
