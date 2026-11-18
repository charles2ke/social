import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { redactSecrets, type PlatformId } from "@social/core";
import {
  DEFAULT_CLAIM_TIMEOUT_MS,
  claimDuePosts,
  completePost,
  failPost,
  getPrismaClient,
  releaseStaleClaims,
  type PrismaClient,
} from "@social/db";
import { createAccountRepository } from "./accounts.js";
import { createPublisher } from "./publisher.js";
import { publishClaimedPost, type PublishFn } from "./publishing.js";

export type WorkerTickResult = { claimed: number; published: number; failed: number; requeued: number };

export type WorkerOptions = {
  prisma: PrismaClient;
  publish: PublishFn;
  /** Resolves the connected account id recorded on each attempt row. */
  accountIdFor?: (platform: PlatformId) => Promise<string | undefined>;
  workerId?: string;
  batchSize?: number;
  claimTimeoutMs?: number;
  now?: Date;
};

/**
 * One scheduler tick: requeue leases abandoned by dead workers, claim the due
 * posts this worker may publish, and publish each of them (see
 * `publishClaimedPost` for how retries avoid double-posting).
 */
export async function runWorkerTick(options: WorkerOptions): Promise<WorkerTickResult> {
  const { prisma } = options;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const now = options.now ?? new Date();
  const claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;

  const { requeued } = await releaseStaleClaims(prisma, { now });
  const posts = await claimDuePosts(prisma, workerId, {
    limit: options.batchSize ?? 5,
    now,
    claimTimeoutMs,
  });

  let published = 0;
  let failed = 0;

  for (const post of posts) {
    const claimToken = post.claimToken ?? undefined;
    const { leaseHeld, errors } = await publishClaimedPost({
      prisma,
      post,
      publish: options.publish,
      accountIdFor: options.accountIdFor,
      claimTimeoutMs,
    });

    if (!leaseHeld) continue;
    if (errors.length) {
      if (await failPost(prisma, post.id, errors.join("; "), { now, ...(claimToken ? { claimToken } : {}) })) failed += 1;
    } else if (await completePost(prisma, post.id, "PUBLISHED", claimToken ? { claimToken } : {})) {
      published += 1;
    }
  }

  return { claimed: posts.length, published, failed, requeued };
}

/**
 * Polls for due posts until the process is asked to stop. Deployed as its own
 * process (`pnpm --filter @social/api start:worker`) so publishing keeps
 * running independently of the HTTP API and can use the least-privilege
 * WORKER_DATABASE_URL role.
 */
export async function startWorker(): Promise<void> {
  const databaseUrl = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("WORKER_DATABASE_URL or DATABASE_URL must be set — the scheduler worker has no queue to poll without a database");
  process.env.DATABASE_URL = databaseUrl;

  const prisma = getPrismaClient();
  const repository = await createAccountRepository();
  const publisher = createPublisher(repository, { mockMode: process.env.MOCK_MODE === "true" });
  const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 15_000);
  const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;

  let stopping = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Let the current tick finish so claimed posts are completed rather than
    // left for the reaper.
    await inFlight;
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

  console.log(JSON.stringify({ level: "info", msg: "scheduler worker started", workerId, intervalMs }));
  while (!stopping) {
    inFlight = runWorkerTick({
      prisma,
      workerId,
      publish: publisher.publish,
      accountIdFor: async (platform) => (await publisher.accountFor(platform))?.id,
      batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 5),
    })
      .then((result) => {
        if (result.claimed || result.requeued) console.log(JSON.stringify({ level: "info", msg: "scheduler tick", workerId, ...result }));
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", msg: "scheduler tick failed", workerId, error: redactSecrets(error instanceof Error ? error.message : String(error)) }));
      });
    await inFlight;
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startWorker().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
