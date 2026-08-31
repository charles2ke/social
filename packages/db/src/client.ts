import { PrismaClient } from "@prisma/client";

/**
 * Consumers of this package (the Next.js web app and the MCP server) run as
 * separate processes and should each configure their own pool size via
 * DATABASE_CONNECTION_LIMIT, since Prisma's default pool sizing assumes a
 * single consumer. See README.md "Connection pooling" for guidance on
 * PgBouncer in production (append `?pgbouncer=true` to DATABASE_URL when
 * pooling in transaction mode).
 */
export interface PrismaClientOptions {
  /** Override DATABASE_URL, e.g. for a per-test throwaway schema. */
  databaseUrl?: string;
  /** Max number of connections this process may open. Defaults to 5. */
  connectionLimit?: number;
  log?: ("query" | "info" | "warn" | "error")[];
}

function buildDatabaseUrl(options: PrismaClientOptions): string | undefined {
  const base = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!base) return base;

  const limit =
    options.connectionLimit ??
    Number(process.env.DATABASE_CONNECTION_LIMIT ?? 5);

  const url = new URL(base);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(limit));
  }
  return url.toString();
}

export function createPrismaClient(
  options: PrismaClientOptions = {},
): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: buildDatabaseUrl(options),
      },
    },
    log: options.log,
  });
}

let sharedClient: PrismaClient | undefined;

/**
 * Lazily-created, process-wide singleton. Both the web app and the MCP
 * server should call this once at startup rather than instantiating
 * PrismaClient directly, so that the connection pool is sized once per
 * process (see DATABASE_CONNECTION_LIMIT).
 */
export function getPrismaClient(): PrismaClient {
  if (!sharedClient) {
    sharedClient = createPrismaClient();
  }
  return sharedClient;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.$disconnect();
    sharedClient = undefined;
  }
}
