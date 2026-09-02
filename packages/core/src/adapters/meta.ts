import type { OAuthSpec } from "../oauth.js";

/** Meta pins API behaviour to a dated version; bump deliberately, not implicitly. */
export const GRAPH_API = "https://graph.facebook.com/v21.0";

export const metaOAuth = (scopes: string[]): OAuthSpec => ({
  authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
  tokenUrl: `${GRAPH_API}/oauth/access_token`,
  scopes,
  clientIdEnv: "META_CLIENT_ID",
  clientSecretEnv: "META_CLIENT_SECRET",
  // Meta issues long-lived tokens that are exchanged, not refreshed.
  refreshable: false,
});

export type GraphInsights = { data?: { name: string; values?: { value?: number }[] }[] };

export const insightValue = (insights: GraphInsights, name: string): number | undefined =>
  insights.data?.find((entry) => entry.name === name)?.values?.[0]?.value;
