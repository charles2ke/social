import { ApiAdapter } from "./base.js";
export const whatsapp = new ApiAdapter("whatsapp", { text: true, image: false, video: false, schedule: true, analytics: false });
