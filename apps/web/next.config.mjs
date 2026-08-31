/**
 * The dashboard is deployed as a static demo to GitHub Pages by
 * `.github/workflows/pages.yml`, which sets `NEXT_STATIC_EXPORT=true` and
 * `NEXT_BASE_PATH=/<repository>`. Local `next dev`/`next start` are unaffected.
 */
const staticExport = process.env.NEXT_STATIC_EXPORT === "true";
const basePath = process.env.NEXT_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
export default {
  ...(staticExport ? { output: "export", images: { unoptimized: true } } : {}),
  basePath,
  trailingSlash: staticExport,
};
