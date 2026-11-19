import { defaultFetch, redactSecrets, type FetchLike } from "@social/core";

export type ApiClientOptions = {
  /** Base URL of the Social API, e.g. http://localhost:3001. */
  apiUrl: string;
  /** The API's `ADMIN_TOKEN`, sent as a bearer token when set. */
  adminToken?: string;
  fetch?: FetchLike;
};

/** A failed API call; `status` is 0 when the API could not be reached at all. Its message is already scrubbed. */
export class SocialApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SocialApiError";
  }
}

export type ApiClient = {
  get<T = unknown>(path: string): Promise<T>;
  /** Always sends a JSON body, since Fastify rejects an empty one declared as JSON. */
  post<T = unknown>(path: string, body?: object): Promise<T>;
  /** Redacts token-like values, and the admin token itself, from text bound for the MCP client. */
  scrub(text: string): string;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseBaseUrl(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("SOCIAL_API_URL must be an http(s) URL, such as http://localhost:3001");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SOCIAL_API_URL must be an http(s) URL, such as http://localhost:3001");
  if (url.username || url.password) throw new Error("SOCIAL_API_URL must not contain credentials; set ADMIN_TOKEN instead");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

/** Node's fetch reports "fetch failed" and keeps the useful part, such as ECONNREFUSED, on `cause`. */
function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (isObject(cause) && typeof cause.code === "string") return cause.code;
  return error.message;
}

/** A client for the Social API, which owns the posts, the scheduler queue and the connected accounts. */
export function createApiClient({ apiUrl, adminToken, fetch = defaultFetch }: ApiClientOptions): ApiClient {
  const baseUrl = parseBaseUrl(apiUrl);
  const scrub = (text: string) => {
    const redacted = redactSecrets(text);
    return adminToken ? redacted.split(adminToken).join("[redacted]") : redacted;
  };

  async function request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (adminToken) headers.authorization = `Bearer ${adminToken}`;

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${baseUrl}${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
      text = await response.text();
    } catch (error) {
      throw new SocialApiError(0, scrub(`Could not reach the Social API at ${baseUrl} (${networkReason(error)}). Is it running? SOCIAL_API_URL sets where to find it.`));
    }

    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON, e.g. a proxy's error page; reported by status below.
    }
    if (response.ok) return payload as T;
    if (response.status === 401) {
      throw new SocialApiError(401, "The Social API rejected the request as unauthorized. Set ADMIN_TOKEN to the API's ADMIN_TOKEN.");
    }
    const detail = isObject(payload) && typeof payload.error === "string" ? payload.error : `${method} ${path} failed`;
    throw new SocialApiError(response.status, scrub(`${detail} (HTTP ${response.status})`));
  }

  return { get: (path) => request("GET", path), post: (path, body) => request("POST", path, body), scrub };
}
