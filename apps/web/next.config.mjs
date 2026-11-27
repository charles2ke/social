/**
 * The dashboard is deployed as a static demo to GitHub Pages by
 * `.github/workflows/pages.yml`, which sets `NEXT_STATIC_EXPORT=true` and
 * `NEXT_BASE_PATH=/<repository>`. Local `next dev`/`next start` are unaffected.
 */
const staticExport = process.env.NEXT_STATIC_EXPORT === "true";
const basePath = process.env.NEXT_BASE_PATH ?? "";
const development = process.env.NODE_ENV !== "production";

/** The browser only ever talks to its own origin and the API. */
function apiOrigin() {
  const url = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL must be an absolute URL, got "${url}"`);
  }
}

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines its bootstrap scripts and the theme script runs before paint, so inline scripts stay allowed; development also evals.
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Media previews load straight from wherever an attachment is hosted.
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  `connect-src 'self' ${apiOrigin()}${development ? " ws: wss:" : ""}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Post ids sit in dashboard URLs; keep them from leaking to media hosts and platform sites.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** @type {import('next').NextConfig} */
export default {
  ...(staticExport ? { output: "export", images: { unoptimized: true } } : {}),
  basePath,
  trailingSlash: staticExport,
  poweredByHeader: false,
  // A static export has no server to send headers; GitHub Pages serves the demo with its own.
  ...(staticExport ? {} : { headers: async () => [{ source: "/:path*", headers: securityHeaders }] }),
};
