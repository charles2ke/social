# Social

AGPL-3.0 self-hosted social-media manager with a Next.js dashboard, Fastify API, and MCP server.

```text
Web (apps/web) ──► API (apps/api) ──► Core adapters/scheduler (packages/core)
MCP stdio server ───────────────────► Core adapters/scheduler
                                      └── SQLite / Prisma schema
```

## Quick start

1. Copy `.env.example` to `.env`, retain `MOCK_MODE=true`, and choose a 32-byte hex `ENCRYPTION_KEY`.
2. Run `corepack pnpm install`, then `corepack pnpm dev`.
3. Open http://localhost:3000. The API runs on port 3001. Use `docker compose up --build` for containers.

Mock mode provides safe demo tokens/accounts and never contacts a platform. Production deployments must use HTTPS, a strong `ADMIN_TOKEN`, and platform credentials. Tokens are encrypted with AES-256-GCM before persistence; errors must not include token values.

## Platforms

| Platform | Publish API / scope | Media | Analytics | Note |
| --- | --- | --- | --- | --- |
| Instagram / Facebook | Meta Graph: `/me/accounts`, IG `media` + `media_publish` | image/video | yes | Register at [Meta](https://developers.facebook.com/docs/instagram-platform/content-publishing/). |
| WhatsApp | Cloud `/{phone-number-id}/messages` | template/text | no | Register [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). |
| LinkedIn | `/rest/posts`, `w_member_social` | image/video | yes | [LinkedIn apps](https://www.linkedin.com/developers/). |
| YouTube | Data API v3 resumable `videos.insert` | video | yes | [Google Cloud](https://console.cloud.google.com/). |
| TikTok | `/v2/post/publish/video/init/` | video | yes | [TikTok developers](https://developers.tiktok.com/). |
| Snapchat | Marketing/Creative API | — | — | Stub: creative publishing access is approval-limited. |
| Strava | `POST /api/v3/activities` | — | no | [Strava API](https://developers.strava.com/). |
| Substack | No public write API | — | no | Stub: export content as an email-ready draft; no scraping/automation. |

Set each client ID/secret in `.env` and configure callback URLs as
`https://your-host/api/oauth/<platform>/callback`. The adapters use typed
`UnsupportedOperation` errors for unavailable public writes and implement
rate-limit retry/backoff at the API boundary. Per-platform keys are documented
in `.env.example`.

## MCP

The MCP server shares `@social/core` with the web/API and exposes account,
draft, publishing, scheduling, status, and analytics tools plus
`social://accounts` and `social://posts/{id}` resources.

```json
{ "mcpServers": { "social": { "command": "node", "args": ["/absolute/path/to/social/packages/mcp-server/dist/mcp-server/src/index.js"], "env": { "MOCK_MODE": "true", "ENCRYPTION_KEY": "your-64-hex-character-key" } } } }
```

Use this in `claude_desktop_config.json` or VS Code MCP settings after
`corepack pnpm build`. It includes the `cross_platform_announcement` prompt.

## Development

`corepack pnpm lint`, `typecheck`, `test`, and `build` validate all workspaces.
The scheduler persists per-platform results (including errors), and its queue
supports cancellation and retries through the API/MCP surface.
