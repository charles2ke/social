/** README screenshots (`DOCS_SCREENSHOTS=1`) are taken on the default ports, so the URLs they show match a normal install. */
export const docsScreenshots = Boolean(process.env.DOCS_SCREENSHOTS);

/** Otherwise dedicated ports keep the e2e servers clear of `pnpm dev` (3000/3001). */
export const webPort = Number(process.env.E2E_WEB_PORT ?? (docsScreenshots ? 3000 : 3200));
export const apiPort = Number(process.env.E2E_API_PORT ?? (docsScreenshots ? 3001 : 3201));
export const webOrigin = `http://localhost:${webPort}`;
export const apiOrigin = `http://localhost:${apiPort}`;
