import type { PlatformSpec } from "./base.js";

const API = "https://www.strava.com/api/v3";

/** Strava has no feed post type; the closest public write endpoint is an activity. */
export const stravaSpec: PlatformSpec = {
  id: "strava",
  capabilities: { text: true, image: false, video: false, schedule: true, analytics: false },
  oauth: {
    authorizeUrl: "https://www.strava.com/oauth/authorize",
    tokenUrl: "https://www.strava.com/oauth/token",
    scopes: ["activity:write", "activity:read"],
    clientIdEnv: "STRAVA_CLIENT_ID",
    clientSecretEnv: "STRAVA_CLIENT_SECRET",
    refreshable: true,
    authorizeParams: { approval_prompt: "auto" },
  },
  async getProfile(ctx) {
    const athlete = await ctx.request<{ id: number; firstname?: string; lastname?: string; profile?: string }>(`${API}/athlete`);
    return {
      id: String(athlete.id),
      name: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || String(athlete.id),
      avatarUrl: athlete.profile,
    };
  },
  async publish(ctx, post) {
    const [name, ...rest] = post.text.split("\n");
    const created = await ctx.request<{ id: number }>(`${API}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: name.slice(0, 255),
        sport_type: ctx.env.STRAVA_SPORT_TYPE ?? "Workout",
        start_date_local: new Date().toISOString(),
        elapsed_time: "0",
        description: rest.join("\n"),
      }).toString(),
    });
    return {
      platformPostId: String(created.id),
      url: `https://www.strava.com/activities/${created.id}`,
      publishedAt: new Date(),
    };
  },
};
