import { buildApp } from "./app.js";
buildApp().listen({ port: Number(process.env.API_PORT ?? 3001), host: "0.0.0.0" }).catch((error: unknown) => { console.error(error); process.exit(1); });
