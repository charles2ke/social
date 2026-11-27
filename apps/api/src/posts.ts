import { randomUUID } from "node:crypto";
import { adapters, redactSecrets, textProblems, type MediaAttachment, type PlatformId, type PlatformOverrides, type PostDraft } from "@social/core";
import type { Prisma } from "@social/db";
import { hasOverrides, storedOverrides } from "./overrides.js";
import type { PlatformOutcome, PublishFn } from "./publishing.js";
import { stringEnv } from "./env.js";

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type StoredPost = {
  id: string;
  text: string;
  media: MediaAttachment[];
  platforms: PlatformId[];
  /** Text that replaces `text` on individual platforms; absent when there is none. */
  platformOverrides?: PlatformOverrides;
  status: PostStatus;
  scheduledFor?: string;
  nextAttemptAt?: string;
  createdAt: string;
  lastError?: string;
  attempts?: { platform: PlatformId; status: string; externalPostId?: string; error?: string }[];
};

export type PostInput = {
  text: string;
  media?: MediaAttachment[];
  platforms?: PlatformId[];
  /** Replaces all of a post's overrides when given; `{}` removes them. */
  platformOverrides?: PlatformOverrides;
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

export const draftOf = (post: StoredPost): PostDraft => ({
  id: post.id,
  text: post.text,
  media: post.media,
  ...(post.platformOverrides ? { perPlatformOverrides: post.platformOverrides } : {}),
});

/** Applies content changes to an in-memory post, dropping the overrides key when they are cleared. */
function withChanges(post: StoredPost, changes: Partial<PostInput> = {}): StoredPost {
  const { platformOverrides, ...rest } = {
    ...post,
    ...(changes.text !== undefined ? { text: changes.text } : {}),
    ...(changes.media !== undefined ? { media: changes.media } : {}),
    ...(changes.platforms !== undefined ? { platforms: changes.platforms } : {}),
    ...(changes.platformOverrides !== undefined ? { platformOverrides: changes.platformOverrides } : {}),
  };
  return hasOverrides(platformOverrides) ? { ...rest, platformOverrides } : rest;
}

export class PostValidationError extends Error {}

function validatePublishable(post: Pick<StoredPost, "platforms" | "text" | "platformOverrides">): void {
  if (!post.platforms.length) throw new PostValidationError("At least one platform is required");
  const problems = post.platforms.flatMap((platform) =>
    textProblems(platform, adapters[platform].textConstraints, post.platformOverrides?.[platform]?.text ?? post.text),
  );
  if (problems.length) throw new PostValidationError(problems.join("; "));
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
      const post = withChanges({
        id: randomUUID(),
        text: input.text,
        media: input.media ?? [],
        platforms: input.platforms ?? [],
        status: input.scheduledFor ? "scheduled" : "draft",
        scheduledFor: input.scheduledFor?.toISOString(),
        createdAt: new Date().toISOString(),
      }, { platformOverrides: input.platformOverrides });
      if (post.status === "scheduled") validatePublishable(post);
      return put(post);
    },
    async update(id, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!editable.has(post.status)) return post;
      const updated = {
        ...withChanges(post, changes),
        ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor.toISOString() } : {}),
      };
      if (updated.status === "scheduled") validatePublishable(updated);
      return put(updated);
    },
    async schedule(id, scheduledFor, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      if (!schedulable.has(post.status)) return post;
      const updated = { ...withChanges(post, changes), status: "scheduled" as const, scheduledFor: scheduledFor.toISOString() };
      validatePublishable(updated);
      return put(updated);
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
      const merged = withChanges(post, changes);
      validatePublishable(merged);
      const claimed = put({ ...merged, status: "publishing", scheduledFor: new Date().toISOString() });
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

  const toPost = (row: PostRow): StoredPost => {
    const platformOverrides = storedOverrides(row.platformOverrides);
    return {
      id: row.id,
      text: row.content,
      media: Array.isArray(row.mediaUrls) ? (row.mediaUrls as unknown as MediaAttachment[]) : [],
      platforms: row.platforms.map((platform) => toPlatformId(platform)),
      ...(hasOverrides(platformOverrides) ? { platformOverrides } : {}),
      status: toStatus(row.status),
      scheduledFor: row.scheduledFor?.toISOString(),
      nextAttemptAt: row.nextAttemptAt?.toISOString(),
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
    };
  };

  const find = async (id: string) => prisma.post.findUnique({ where: { id }, include: { attempts: true } });
  const withLockedPost = <T>(id: string, work: (tx: Prisma.TransactionClient, row: PostRow | null) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id = ${id} FOR UPDATE`;
      const row = await tx.post.findUnique({ where: { id }, include: { attempts: true } });
      return work(tx, row);
    }, { isolationLevel: "ReadCommitted" });
  const contentChanges = (changes?: Partial<PostInput>) => ({
    ...(changes?.text !== undefined ? { content: changes.text } : {}),
    ...(changes?.media !== undefined ? { mediaUrls: changes.media as unknown as object } : {}),
    ...(changes?.platforms !== undefined ? { platforms: changes.platforms.map(toPlatformEnum) } : {}),
    ...(changes?.platformOverrides !== undefined ? { platformOverrides: changes.platformOverrides as object } : {}),
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
      if (input.scheduledFor) {
        validatePublishable({ text: input.text, platforms: input.platforms ?? [], platformOverrides: input.platformOverrides });
      }
      const row = await prisma.post.create({
        data: {
          content: input.text,
          mediaUrls: (input.media ?? []) as unknown as object,
          platforms: (input.platforms ?? []).map(toPlatformEnum),
          ...(hasOverrides(input.platformOverrides) ? { platformOverrides: input.platformOverrides as object } : {}),
          status: input.scheduledFor ? "SCHEDULED" : "DRAFT",
          scheduledFor: input.scheduledFor ?? null,
        },
        include: { attempts: true },
      });
      return toPost(row);
    },
    async update(id, changes) {
      return withLockedPost(id, async (tx, row) => {
        if (!row) return undefined;
        const post = toPost(row);
        if (!editable.has(post.status)) return post;
        if (post.status === "scheduled") validatePublishable(withChanges(post, changes));
        const updated = await tx.post.update({
          where: { id },
          data: {
            ...contentChanges(changes),
            ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor } : {}),
          },
          include: { attempts: true },
        });
        return toPost(updated);
      });
    },
    async schedule(id, scheduledFor, changes) {
      // Requeuing starts a fresh retry budget, so a failed post that exhausted
      // its attempts gets the full set again rather than a single try.
      return withLockedPost(id, async (tx, row) => {
        if (!row) return undefined;
        const post = toPost(row);
        if (!schedulable.has(post.status)) return post;
        validatePublishable(withChanges(post, changes));
        const updated = await tx.post.update({
          where: { id },
          data: {
            ...contentChanges(changes),
            status: "SCHEDULED",
            scheduledFor,
            attemptCount: 0,
            nextAttemptAt: null,
            claimExpiresAt: null,
            claimToken: null,
          },
          include: { attempts: true },
        });
        return toPost(updated);
      });
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
      const result = await withLockedPost(id, async (tx, row) => {
        if (!row) return undefined;
        const post = toPost(row);
        if (!schedulable.has(post.status)) return { claimed: false as const, post };
        validatePublishable(withChanges(post, changes));
        const claimed = await claimPost(tx, id, `api-${randomUUID()}`, { data: contentChanges(changes) });
        if (!claimed) throw new Error("Post claim failed while locked");
        return { claimed: true as const, post: claimed };
      });
      if (!result || !result.claimed) return result;
      const claimed = result.post;
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
  if (stringEnv(process.env, "DATABASE_URL")) return createPrismaPostRepository();
  if (process.env.MOCK_MODE !== "true") {
    console.warn("DATABASE_URL is not set — drafts and scheduled posts will only live in memory and are never published by the worker");
  }
  return createMemoryPostRepository();
}
