import { randomUUID } from "node:crypto";
import type { MediaAttachment, PlatformId, PostDraft } from "@social/core";

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type StoredPost = {
  id: string;
  text: string;
  media: MediaAttachment[];
  platforms: PlatformId[];
  status: PostStatus;
  scheduledFor?: string;
  createdAt: string;
  lastError?: string;
  attempts?: { platform: PlatformId; status: string; externalPostId?: string; error?: string }[];
};

export type PostInput = { text: string; media?: MediaAttachment[]; platforms?: PlatformId[]; scheduledFor?: Date };

export interface PostRepository {
  list(status?: PostStatus): Promise<StoredPost[]>;
  get(id: string): Promise<StoredPost | undefined>;
  create(input: PostInput): Promise<StoredPost>;
  update(id: string, changes: Partial<PostInput>): Promise<StoredPost | undefined>;
  /** Moves a draft (or an already scheduled post) into the worker's queue. */
  schedule(id: string, scheduledFor: Date): Promise<StoredPost | undefined>;
  cancel(id: string): Promise<StoredPost | undefined>;
}

const draftOf = (post: StoredPost): PostDraft => ({ id: post.id, text: post.text, media: post.media });
export { draftOf };

/** Used when no DATABASE_URL is configured (e.g. the mock-mode demo). */
export function createMemoryPostRepository(): PostRepository {
  const posts = new Map<string, StoredPost>();
  const put = (post: StoredPost) => {
    posts.set(post.id, post);
    return post;
  };
  return {
    async list(status) {
      return [...posts.values()].filter((post) => !status || post.status === status);
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
        status: input.scheduledFor ? "scheduled" : "draft",
        scheduledFor: input.scheduledFor?.toISOString(),
        createdAt: new Date().toISOString(),
      });
    },
    async update(id, changes) {
      const post = posts.get(id);
      if (!post) return undefined;
      return put({
        ...post,
        ...(changes.text !== undefined ? { text: changes.text } : {}),
        ...(changes.media !== undefined ? { media: changes.media } : {}),
        ...(changes.platforms !== undefined ? { platforms: changes.platforms } : {}),
        ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor.toISOString() } : {}),
      });
    },
    async schedule(id, scheduledFor) {
      const post = posts.get(id);
      if (!post) return undefined;
      return put({ ...post, status: "scheduled", scheduledFor: scheduledFor.toISOString() });
    },
    async cancel(id) {
      const post = posts.get(id);
      if (!post) return undefined;
      return put({ ...post, status: "cancelled" });
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
export async function createPrismaPostRepository(): Promise<PostRepository> {
  const { getPrismaClient }: PrismaModule = await import("@social/db");
  const prisma = getPrismaClient();

  const toPost = (row: PostRow): StoredPost => ({
    id: row.id,
    text: row.content,
    media: Array.isArray(row.mediaUrls) ? (row.mediaUrls as unknown as MediaAttachment[]) : [],
    platforms: row.platforms.map((platform) => toPlatformId(platform)),
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
          status: input.scheduledFor ? "SCHEDULED" : "DRAFT",
          scheduledFor: input.scheduledFor ?? null,
        },
        include: { attempts: true },
      });
      return toPost(row);
    },
    async update(id, changes) {
      if (!(await find(id))) return undefined;
      const row = await prisma.post.update({
        where: { id },
        data: {
          ...(changes.text !== undefined ? { content: changes.text } : {}),
          ...(changes.media !== undefined ? { mediaUrls: changes.media as unknown as object } : {}),
          ...(changes.platforms !== undefined ? { platforms: changes.platforms.map(toPlatformEnum) } : {}),
          ...(changes.scheduledFor !== undefined ? { scheduledFor: changes.scheduledFor } : {}),
        },
        include: { attempts: true },
      });
      return toPost(row);
    },
    async schedule(id, scheduledFor) {
      if (!(await find(id))) return undefined;
      const row = await prisma.post.update({
        where: { id },
        data: { status: "SCHEDULED", scheduledFor, nextAttemptAt: null, claimExpiresAt: null },
        include: { attempts: true },
      });
      return toPost(row);
    },
    async cancel(id) {
      const existing = await find(id);
      if (!existing) return undefined;
      // A post the worker already claimed is mid-publish; cancelling it would
      // not stop the in-flight platform calls, so it is refused.
      if (existing.status === "PUBLISHING" || existing.status === "PUBLISHED") return toPost(existing);
      const row = await prisma.post.update({
        where: { id },
        data: { status: "CANCELLED", scheduledFor: null, nextAttemptAt: null, claimExpiresAt: null },
        include: { attempts: true },
      });
      return toPost(row);
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
