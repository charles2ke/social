import { redactSecrets } from "@social/core";

/** A non-2xx response from the Social API, carrying the API's own error message. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiClient = {
  /** `path` is relative to the API URL and must already have its dynamic segments encoded. */
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
};

export type ApiClientOptions = {
  baseUrl: string;
  /** ADMIN_TOKEN of the API; optional only for a mock-mode API without one. */
  token?: string;
  fetch?: typeof fetch;
  /** Publishing a video can take minutes, so the default is generous. */
  timeoutMs?: number;
};

/**
 * Talks to the Social API, so the MCP server shares its connected accounts,
 * validation (media, text limits) and storage instead of keeping its own.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new Error(`SOCIAL_API_URL is not a valid URL: "${options.baseUrl}"`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("SOCIAL_API_URL must be an http(s) URL");
  if (base.username || base.password) throw new Error("SOCIAL_API_URL must not contain credentials — set SOCIAL_API_TOKEN instead");
  const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;

  return {
    async request(method, path, body) {
      const url = new URL(path.replace(/^\/+/, ""), root);
      if (!url.href.startsWith(root)) throw new Error(`Refusing to call ${url.pathname} outside the Social API`);
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            accept: "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Never follow a redirect with the admin token attached.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : "it is not reachable";
        throw new Error(`Could not call the Social API at ${base.origin}: ${reason}`, { cause: error });
      }
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw new ApiError(response.status, `Unexpected non-JSON response (HTTP ${response.status})`);
      }
      if (response.ok) return data;
      if (response.status === 401) throw new ApiError(401, "The Social API rejected the credentials — set SOCIAL_API_TOKEN to the API's ADMIN_TOKEN");
      const message = typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `HTTP ${response.status}`;
      throw new ApiError(response.status, redactSecrets(message));
    },
  };
}
