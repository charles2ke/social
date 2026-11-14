import { randomUUID } from "node:crypto";
import { redactSecrets, type MediaAttachment, type PlatformId, type PlatformOverrides, type PostDraft } from "@social/core";
import type { PlatformOutcome, PublishFn } from "./publishing.js";

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type StoredPost = {
  id: string;
  text: string;
  media: MediaAttachment[];
  platforms: PlatformId[];
  /** Text or attachments that replace the post's on one platform; omitted when there are none. */
  perPlatformOverrides?: PlatformOverrides;
  status: PostStatus;
  scheduledFor?: string;
  createdAt: string;
  lastError?: string;
  attempts?: { platform: PlatformId; status: string; externalPostId?: string; error?: string }[];
};

export type PostInput = {
  text: string;
  media?: MediaAttachment[];
  platforms?: PlatformId[];
  /** Replaces all of the post's overrides; `{}` removes them. */
  perPlatformOverrides?: PlatformOverrides;
  scheduledFor?: Date;
};

/** How a repository reaches the platforms when a stored post is published immediately. */
export type PostPublisher = {
  publish: PublishFn;
  /** Resolves the connected account id recorded on each attempt. */
  accountIdFor?: (platform: PlatformId) => Promise<string | undefined>;
};

export type PublishNowResult =
  | { claimed: true; post: StoredPost; results: PlatformOutcome[] }
  /** The post's status did not allow publishing; it is returned unchanged. */
  | { claimed: false; post: StoredPost };

export interface PostRepository {
  /** Newest first. */
  list(status?: PostStatus): Promise<StoredPost[]>;
  get(id: string): Promise<StoredPost | undefined>;
  create(input: PostInput): Promise<StoredPost>;
  /** Returns the post unchanged when its status no longer allows editing (see `isEditable`). */
  update(id: string, changes: Partial<PostInput>): Promise<StoredPost | undefined>;
  /**
   * Moves a draft (or an already scheduled post) into the worker's queue,
   * applying `changes` in the same transition. Returns the post unchanged when
   * its status does not allow scheduling, so the caller can report a conflict.
   */
  schedule(id: string, scheduledFor: Date, changes?: Partial<PostInput>): Promise<StoredPost | undefined>;
  /** Returns the post unchanged when it is already claimed or terminal. */
  cancel(id: string): Promise<StoredPost | undefined>;
  /**
   * Publishes a draft, scheduled or failed post right away, applying `changes`
   * in the same transition. Platforms that already succeeded are skipped, so
   * retrying a partially failed post never double-posts. The post ends up
   * `published`, or `failed` with `lastError` — it is not retried
   * automatically, the caller decides whether to retry or reschedule.
   */
  publishNow(id: string, publisher: PostPublisher, changes?: Partial<PostInput>): Promise<PublishNowResult | undefined>;
}

/**
 * Lifecycle guard: a post may only be (re)queued or cancelled while it is not
 * claimed by the worker and not in a terminal state — a published post must
 * never be silently requeued, and a cancelled one must not be republished.
 */
const schedulable = new Set<PostStatus>(["draft", "scheduled", "failed"]);
const cancellable = new Set<PostStatus>(["draft", "scheduled", "failed"]);
/** Editing is refused once the worker owns the post or it reached a terminal state. */
const editable = new Set<PostStatus>(["draft", "scheduled", "failed"]);
export const isEditable = (status: PostStatus) => editable.has(status);

const draftOf = (post: StoredPost): PostDraft => ({
  id: post.id,
  text: post.text,
  media: post.media,
  ...(post.perPlatformOverrides ? { perPlatformOverrides: post.perPlatformOverrides } : {}),
});
export { draftOf };

/** The post's overrides as a field, left out when there are none so both repositories serialize posts alike. */
const overridesField = (overrides: PlatformOverrides | null | undefined) =>
  overrides && Object.keys(overrides).length ? { perPlatformOverrides: overrides } : {};

/** Applies the content fields `changes` sets; the rest keep their stored values. */
function withChanges(post: StoredPost, changes: Partial<PostInput> = {}): StoredPost {
  const { perPlatformOverrides, ...rest } = post;
  return {
    ...rest,
    ...overridesField(changes.perPlatformOverrides ?? perPlatformOverrides),
    ...(changes.text !== undefined ? { text: changes.text } : {}),
    ...(changes.media !== undefined ? { media: changes.media } : {}),
    ...(changes.platforms !== undefined ? { platforms: changes.platforms } : {}),
  };
}

/** Used when no DATABASE_URL is configured (e.g. the mock-mode demo). */
export function createMemoryPostRepository(): PostRepository {
  const posts = new Map<string, StoredPost>();
  const put = (post: StoredPost) => {
    posts.set(post.id, post);
    return post;
  };
  return {
    async list(status) {
      // Map iteration follows insertion (creation) order.
      return [...posts.values()].reverse().filter((post) => !status || post.status === status);
    },
    async get(id) {
      return posts.get(id);
    },
    async create(input) {
      return put({
        id: randomUUID(),
        text: input.text,
        media: input.media ?? [],
        platforms: input.platforms ?? [],
        ...overridesField(input.perPlatformOverrides),
        status: input.scheduledFor ? "scheduled" : "draft",
        scheduledFor: input.scheduledFor?.toISOString(),
        createdAt: new Date().toISOString(),
      });
    },
    async update(id, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!editable.has(post.status)) return post;
      return put({
        ...withChanges(post, changes),
        ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor.toISOString() } : {}),
      });
    },
    async schedule(id, scheduledFor, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!schedulable.has(post.status)) return post;
      return put({ ...withChanges(post, changes), status: "scheduled", scheduledFor: scheduledFor.toISOString() });
    },
    async cancel(id) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!cancellable.has(post.status)) return post;
      return put({ ...post, status: "cancelled" });
    },
    async publishNow(id, publisher, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!schedulable.has(post.status)) return { claimed: false, post };
      // Claimed synchronously, before the first await, so a concurrent request sees "publishing" and is refused.
      const claimed = put({ ...withChanges(post, changes), status: "publishing", scheduledFor: new Date().toISOString() });
      const attempts = new Map((claimed.attempts ?? []).map((attempt) => [attempt.platform, attempt]));
      const results: PlatformOutcome[] = [];
      const errors = claimed.platforms.length ? [] : ["no target platforms — the post cannot be published"];
      for (const platform of claimed.platforms) {
        if (attempts.get(platform)?.status === "success") continue;
        try {
          const result = await publisher.publish(platform, draftOf(claimed));
          attempts.set(platform, { platform, status: "success", externalPostId: result.platformPostId });
          results.push({ platform, status: "published", platformPostId: result.platformPostId, ...(result.url ? { url: result.url } : {}) });
        } catch (error) {
          const message = redactSecrets(error instanceof Error ? error.message : "Publishing failed");
          attempts.set(platform, { platform, status: "failed", error: message });
          errors.push(`${platform}: ${message}`);
          results.push({ platform, status: "failed", error: message });
        }
      }
      const settled: StoredPost = { ...claimed, attempts: [...attempts.values()], status: errors.length ? "failed" : "published" };
      if (errors.length) settled.lastError = errors.join("; ");
      else delete settled.lastError;
      return { claimed: true, post: put(settled), results };
    },
  };
}

type PrismaModule = typeof import("@social/db");
type PrismaClient = ReturnType<PrismaModule["getPrismaClient"]>;
type PostRow = Awaited<ReturnType<PrismaClient["post"]["findFirstOrThrow"]>> & {
  attempts?: { platform: string; status: string; externalPostId: string | null; error: string | null }[];
};

const toPlatformEnum = (platform: PlatformId) => platform.toUpperCase() as Uppercase<PlatformId>;
const toPlatformId = (value: string) => value.toLowerCase() as PlatformId;
const toStatus = (value: string) => value.toLowerCase() as PostStatus;
const toStatusEnum = (value: PostStatus) => value.toUpperCase() as Uppercase<PostStatus>;
const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Postgres-backed posts. This is what makes scheduling durable: the scheduler
 * worker claims rows from the same `posts` table (see
 * packages/db/src/scheduler.ts), so a post survives an API restart and is
 * visible to every replica.
 */
export async function createPrismaPostRepository(options: { prisma?: PrismaClient } = {}): Promise<PostRepository> {
  const { DEFAULT_CLAIM_TIMEOUT_MS, claimPost, completePost, getPrismaClient }: PrismaModule = await import("@social/db");
  // Loaded lazily like @social/db itself, so the in-memory mode never needs a generated Prisma client.
  const { publishClaimedPost } = await import("./publishing.js");
  const prisma = options.prisma ?? getPrismaClient();

  const toPost = (row: PostRow): StoredPost => ({
    id: row.id,
    text: row.content,
    media: Array.isArray(row.mediaUrls) ? (row.mediaUrls as unknown as MediaAttachment[]) : [],
    platforms: row.platforms.map((platform) => toPlatformId(platform)),
    ...overridesField(isJsonObject(row.platformOverrides) ? (row.platformOverrides as PlatformOverrides) : undefined),
    status: toStatus(row.status),
    scheduledFor: row.scheduledFor?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.attempts?.length
      ? {
          attempts: row.attempts.map((attempt) => ({
            platform: toPlatformId(attempt.platform),
            status: attempt.status.toLowerCase(),
            ...(attempt.externalPostId ? { externalPostId: attempt.externalPostId } : {}),
            ...(attempt.error ? { error: attempt.error } : {}),
          })),
        }
      : {}),
  });

  const find = async (id: string) => prisma.post.findUnique({ where: { id }, include: { attempts: true } });
  const contentChanges = (changes?: Partial<PostInput>) => ({
    ...(changes?.text !== undefined ? { content: changes.text } : {}),
    ...(changes?.media !== undefined ? { mediaUrls: changes.media as unknown as object } : {}),
    ...(changes?.platforms !== undefined ? { platforms: changes.platforms.map(toPlatformEnum) } : {}),
    ...(changes?.perPlatformOverrides !== undefined ? { platformOverrides: changes.perPlatformOverrides as object } : {}),
  });

  return {
    async list(status) {
      const rows = await prisma.post.findMany({
        where: status ? { status: toStatusEnum(status) } : undefined,
        include: { attempts: true },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toPost);
    },
    async get(id) {
      const row = await find(id);
      return row ? toPost(row) : undefined;
    },
    async create(input) {
      const row = await prisma.post.create({
        data: {
          content: input.text,
          mediaUrls: (input.media ?? []) as unknown as object,
          platforms: (input.platforms ?? []).map(toPlatformEnum),
          ...(input.perPlatformOverrides ? { platformOverrides: input.perPlatformOverrides as object } : {}),
          status: input.scheduledFor ? "SCHEDULED" : "DRAFT",
          scheduledFor: input.scheduledFor ?? null,
        },
        include: { attempts: true },
      });
      return toPost(row);
    },
    async update(id, changes) {
      // Conditional on an editable status so a post the worker just claimed is
      // never changed underneath its in-flight platform calls.
      await prisma.post.updateMany({
        where: { id, status: { in: [...editable].map(toStatusEnum) } },
        data: {
          ...contentChanges(changes),
          ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor } : {}),
        },
      });
      const row = await find(id);
      return row ? toPost(row) : undefined;
    },
    async schedule(id, scheduledFor, changes) {
      // Conditional on the current status so a published, cancelled or
      // in-flight post is never requeued by a racing request; the caller sees
      // the unchanged row and reports a conflict.
      // Requeuing starts a fresh retry budget, so a failed post that exhausted
      // its attempts gets the full set again rather than a single try.
      await prisma.post.updateMany({
        where: { id, status: { in: [...schedulable].map(toStatusEnum) } },
        data: {
          ...contentChanges(changes),
          status: "SCHEDULED",
          scheduledFor,
          attemptCount: 0,
          nextAttemptAt: null,
          claimExpiresAt: null,
          claimToken: null,
        },
      });
      const row = await find(id);
      return row ? toPost(row) : undefined;
    },
    async cancel(id) {
      // A post the worker already claimed is mid-publish; cancelling it would
      // not stop the in-flight platform calls, so the update is conditional on
      // a still-cancellable status rather than on a separate status read.
      await prisma.post.updateMany({
        where: { id, status: { in: [...cancellable].map(toStatusEnum) } },
        data: { status: "CANCELLED", scheduledFor: null, nextAttemptAt: null, claimExpiresAt: null, claimToken: null },
      });
      const row = await find(id);
      return row ? toPost(row) : undefined;
    },
    async publishNow(id, publisher, changes) {
      // The claim is the same lease the worker uses, so the worker can neither
      // pick the post up mid-publish nor lose it if this process dies.
      const claimed = await claimPost(prisma, id, `api-${randomUUID()}`, { data: contentChanges(changes) });
      if (!claimed) {
        const row = await find(id);
        return row ? { claimed: false, post: toPost(row) } : undefined;
      }
      const claimToken = claimed.claimToken ?? undefined;
      const outcome = await publishClaimedPost({
        prisma,
        post: claimed,
        publish: publisher.publish,
        accountIdFor: publisher.accountIdFor,
        claimTimeoutMs: DEFAULT_CLAIM_TIMEOUT_MS,
      });
      if (outcome.leaseHeld) {
        const failed = outcome.errors.length > 0;
        await completePost(prisma, id, failed ? "FAILED" : "PUBLISHED", {
          ...(claimToken ? { claimToken } : {}),
          ...(failed ? { lastError: outcome.errors.join("; ") } : {}),
        });
      }
      const row = await find(id);
      return row ? { claimed: true, post: toPost(row), results: outcome.results } : undefined;
    },
  };
}

export async function createPostRepository(): Promise<PostRepository> {
  if (process.env.DATABASE_URL) return createPrismaPostRepository();
  if (process.env.MOCK_MODE !== "true") {
    console.warn("DATABASE_URL is not set — drafts and scheduled posts will only live in memory and are never published by the worker");
  }
  return createMemoryPostRepository();
}
