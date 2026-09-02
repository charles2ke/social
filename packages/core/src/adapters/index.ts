import { ApiAdapter, type AdapterDeps, type PlatformSpec } from "./base.js";
import { facebookSpec } from "./facebook.js";
import { instagramSpec } from "./instagram.js";
import { linkedinSpec } from "./linkedin.js";
import { snapchatSpec } from "./snapchat.js";
import { stravaSpec } from "./strava.js";
import { substackSpec } from "./substack.js";
import { tiktokSpec } from "./tiktok.js";
import { whatsappSpec } from "./whatsapp.js";
import { youtubeSpec } from "./youtube.js";

export const specs = {
  instagram: instagramSpec,
  facebook: facebookSpec,
  whatsapp: whatsappSpec,
  linkedin: linkedinSpec,
  substack: substackSpec,
  youtube: youtubeSpec,
  snapchat: snapchatSpec,
  tiktok: tiktokSpec,
  strava: stravaSpec,
} satisfies Record<string, PlatformSpec>;

export type Adapters = Record<keyof typeof specs, ApiAdapter>;

/** `deps` lets tests (and alternative runtimes) inject fetch/env. */
export function createAdapters(deps: AdapterDeps = {}): Adapters {
  return Object.fromEntries(
    Object.entries(specs).map(([id, spec]) => [id, new ApiAdapter(spec, deps)]),
  ) as Adapters;
}

export const adapters = createAdapters();
