# Security policy

## Supported versions

Security fixes are made on `main` and ship in the next release. Only the
latest release and `main` are supported, so keep your installation current.

## Reporting a vulnerability

Please **do not open a public issue, discussion or pull request** for a
security problem.

Report it privately with GitHub's
[private vulnerability reporting](https://github.com/charles2ke/social/security/advisories/new)
(**Security → Report a vulnerability** on the repository). Please include:

- what an attacker can do, and what they need first (network access, the
  admin token, a connected account, …);
- steps or a proof of concept to reproduce it, and the commit or release you
  tested;
- a suggested fix, if you have one.

This is a volunteer-maintained project without a bug bounty. Reports are
handled on a best-effort basis: the conversation and the fix are coordinated
in the private advisory, and you are credited when it is published unless
you prefer otherwise. Please give us a reasonable chance to release a fix
before disclosing the problem publicly.

## Scope

In scope is everything in this repository: the API, the scheduler worker,
the dashboard, the MCP server, the Docker image and the Compose file. For
example:

- bypassing authentication, or forging or reusing sessions;
- leaking OAuth tokens, the admin token or the encryption key through logs,
  responses or errors;
- cross-site scripting, CSRF or open redirects in the dashboard or the OAuth
  flow;
- the worker's database role reaching data it is not granted;
- server-side request forgery through media URLs.

Out of scope:

- the static GitHub Pages demo, which has no backend;
- mock mode without an `ADMIN_TOKEN`, which is an open local demo by design
  (it listens on localhost only);
- deployments that ignore the checklist below, such as serving over plain
  HTTP or exposing the Compose file's `trust`-authenticated Postgres;
- vulnerabilities in the social platforms' own APIs.

## Deployment checklist

Before exposing an installation to a network:

1. Set `MOCK_MODE=false`, and generate `ADMIN_TOKEN` and `ENCRYPTION_KEY`
   with `openssl rand -hex 32` each. Keep them in a secret manager, never in
   git.
2. Serve the dashboard and the API over HTTPS only, behind a TLS-terminating
   reverse proxy. Set `TRUST_PROXY` to match it, so rate limits see client
   addresses and the API sends HSTS; add HSTS for the dashboard at the proxy.
3. Set `BASE_URL` and `WEB_ORIGIN` to the dashboard's public URL and
   `OAUTH_REDIRECT_BASE_URL` to the API's, and build the dashboard with
   `NEXT_PUBLIC_API_URL` set to the API's public URL.
4. Use a password-protected Postgres with TLS (`sslmode=require`), not the
   Compose file's `trust` authentication. Run the worker as the
   `social_worker` role through `WORKER_DATABASE_URL`, with its own password.
5. Keep `SESSION_TTL_HOURS` short. Signing out is remembered only by the API
   process that handled it, so to revoke every session (after a leak, say)
   rotate `ADMIN_TOKEN`.
6. Back up `ENCRYPTION_KEY` with the database: stored OAuth tokens cannot be
   decrypted without it, and changing it means reconnecting every account.
7. Register only the exact OAuth callback URLs with each platform, and
   disconnect accounts you no longer publish to — then revoke the app's
   access in the platform's settings too.
8. Keep dependencies and the base image up to date (Dependabot opens weekly
   updates for this repository), and check `pnpm audit`.

## How secrets are protected

- OAuth tokens are encrypted with AES-256-GCM before they are stored, and
  every error or platform response passes through `redactSecrets` before it
  reaches a log, the database or an API response.
- The admin token is compared in constant time and never stored by the
  dashboard, which exchanges it for a session token signed with a key derived
  from it. Sign-in attempts and the OAuth callback have their own, tighter
  rate limits.
- The OAuth `state` is HMAC-signed, expires after ten minutes and is
  single-use, and the callback only redirects to allow-listed dashboard
  origins.
- Media downloads (for YouTube uploads) refuse private and reserved
  addresses, re-check every redirect, and are capped in size.
- Every API response carries `Cache-Control: no-store`, `nosniff`, a
  `default-src 'none'` Content-Security-Policy and `X-Frame-Options: DENY`;
  the dashboard sends its own Content-Security-Policy.
- The worker's `social_worker` role can only read and update what publishing
  needs (see README.md, "Least-privilege worker role"), and the containers
  run as a non-root user with a read-only filesystem and no Linux
  capabilities.
