import type { PlatformId } from "./types.js";

/** Injectable so adapters can be unit-tested without real network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const SECRET_KEYS = ["access_token", "refresh_token", "client_secret", "code", "authorization"];

/**
 * Platform responses (and our own request bodies) routinely contain tokens.
 * Every value that reaches an error message goes through here first so that
 * tokens are never written to logs or returned to API clients.
 */
export function redactSecrets(value: string): string {
  let result = value;
  for (const key of SECRET_KEYS) {
    result = result.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "gi"), "$1[redacted]$2");
    result = result.replace(new RegExp(`(\\b${key}=)[^&\\s]+`, "gi"), "$1[redacted]");
  }
  return result;
}

export class PlatformApiError extends Error {
  /** Redacted at construction: platform error payloads can echo tokens back, and this object gets logged and serialized. */
  readonly detail: string;

  constructor(
    readonly platform: PlatformId,
    readonly status: number,
    detail: string,
  ) {
    const safeDetail = redactSecrets(detail).slice(0, 500);
    super(`${platform} API request failed with status ${status}: ${safeDetail}`);
    this.detail = safeDetail;
    this.name = "PlatformApiError";
  }
}

/** Thrown when a platform is enabled but its credentials/settings are missing. */
export class ConfigurationError extends Error {
  constructor(platform: PlatformId, missing: string) {
    super(`${platform} is not configured: set ${missing}`);
    this.name = "ConfigurationError";
  }
}

export async function requestJson<T>(platform: PlatformId, doFetch: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  const response = await doFetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new PlatformApiError(platform, response.status, body);
  return (body ? JSON.parse(body) : {}) as T;
}
