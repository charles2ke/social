import { platformIds, type PlatformId, type PlatformOverrides } from "@social/core";

const isPlatform = (value: string): value is PlatformId => (platformIds as readonly string[]).includes(value);

/**
 * Validates a `platformOverrides` value: an object keyed by platform id whose
 * entries replace the post's text on that platform (`{ linkedin: { text } }`).
 * Blank overrides are dropped, so clearing a platform's custom text falls
 * back to the main text. Returns the error instead of throwing.
 */
export function parsePlatformOverrides(value: unknown): PlatformOverrides | Error {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return new Error("platformOverrides must be an object keyed by platform id");
  const overrides: PlatformOverrides = {};
  for (const [platform, override] of Object.entries(value)) {
    if (!isPlatform(platform)) return new Error(`Unknown platform in platformOverrides: ${platform.slice(0, 50)}`);
    const text = typeof override === "object" && override !== null ? (override as { text?: unknown }).text : undefined;
    if (typeof text !== "string") return new Error(`platformOverrides.${platform}.text must be a string`);
    if (text.trim()) overrides[platform] = { text };
  }
  return overrides;
}

/** Reads stored overrides leniently: a malformed value publishes the main text rather than failing the post. */
export function storedOverrides(value: unknown): PlatformOverrides {
  const overrides = value === undefined ? {} : parsePlatformOverrides(value);
  return overrides instanceof Error ? {} : overrides;
}

export const hasOverrides = (overrides: PlatformOverrides | undefined): overrides is PlatformOverrides =>
  Boolean(overrides && Object.keys(overrides).length);
