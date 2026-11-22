import { buildApp } from "./app.js";
import { createAccountRepository } from "./accounts.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { stringEnv } from "./env.js";
import { createPostRepository } from "./posts.js";
import { createPublisher } from "./publisher.js";

let config: ApiConfig;
try {
  config = loadConfig();
} catch (error) {
  // A configuration mistake gets one readable line, not a stack trace.
  console.error(JSON.stringify({ level: "fatal", msg: "invalid configuration", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}

const usesDatabase = Boolean(stringEnv(process.env, "DATABASE_URL"));
const accounts = await createAccountRepository();
const posts = await createPostRepository();
const publisher = createPublisher(accounts, { mockMode: config.mockMode });
const app = await buildApp({
  config,
  accounts,
  posts,
  publisher,
  ...(usesDatabase
    ? {
        checkDatabase: async () => {
          const { getPrismaClient } = await import("@social/db");
          await getPrismaClient().$queryRaw`SELECT 1`;
        },
      }
    : {}),
});

let shuttingDown = false;
/** Close the server and the database pool so a rolling deploy drains instead of dropping requests. */
async function shutdown(signal: string) {
  // A terminal and a process wrapper can both deliver the same Ctrl+C; drain once.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  setTimeout(() => {
    console.error(JSON.stringify({ level: "error", msg: "shutdown timed out" }));
    process.exit(1);
  }, 10_000).unref();
  try {
    await app.close();
    if (usesDatabase) {
      const { disconnectPrismaClient } = await import("@social/db");
      await disconnectPrismaClient();
    }
  } finally {
    process.exit(0);
  }
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(
    JSON.stringify({
      level: "info",
      msg: "api listening",
      addresses: app.addresses().map((info) => (typeof info === "string" ? info : `${info.address}:${info.port}`)),
      auth: config.adminToken ? "admin token" : "open (mock mode)",
      storage: usesDatabase ? "postgres" : "memory",
      mockMode: config.mockMode,
    }),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
}
