"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../config";
import { AlertIcon, CheckIcon, ClockIcon, CopyIcon, PencilIcon, PlatformIcon, PlusIcon, RefreshIcon, SendIcon, XIcon } from "../icons";
import { platformMeta } from "../platforms";
import {
  ApiError,
  attemptFor,
  callApi,
  errorMessage,
  isEditable,
  remainingPlatforms,
  type PostStatus,
  type PublishNowResponse,
  type StoredPost,
} from "../posts";
import { StatusBadge } from "../components/post-status";
import { StorageNotice, useStorageMode } from "../components/storage-notice";

type Filter = "all" | PostStatus;
type Notice = { message: string; tone: "success" | "error" };

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "scheduled", label: "Scheduled" },
  { id: "publishing", label: "Publishing" },
  { id: "published", label: "Published" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

/** The worker publishes in the background, so the list polls to pick up its progress. */
const refreshMs = 10_000;

const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const labels = (platforms: string[]) => platforms.map((platform) => platformMeta(platform).label).join(", ");

function timeline(post: StoredPost): string {
  if (post.status === "scheduled" && post.scheduledFor) return `Publishes ${formatDate(post.scheduledFor)}`;
  if (post.status === "publishing") return "Publishing now…";
  return `Created ${formatDate(post.createdAt)}`;
}

function PlatformChip({ post, platform }: { post: StoredPost; platform: string }) {
  const meta = platformMeta(platform);
  const attempt = attemptFor(post, platform);
  return (
    <li className="flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-xs" title={attempt?.error}>
      <PlatformIcon platform={platform} width={14} height={14} style={{ color: meta.accent }} />
      <span className="font-medium">{meta.label}</span>
      {post.perPlatformOverrides?.[platform] ? (
        <span className="text-ink-muted" title={`${meta.label} gets its own text or attachments`}>
          <PencilIcon width={12} height={12} />
          <span className="sr-only"> (customized)</span>
        </span>
      ) : null}
      {attempt?.status === "success" ? (
        <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
          <CheckIcon width={12} height={12} /> published
        </span>
      ) : attempt?.status === "failed" ? (
        <span className="flex items-center gap-0.5 text-rose-500">
          <AlertIcon width={12} height={12} /> failed
        </span>
      ) : attempt?.status === "pending" ? (
        <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
          <ClockIcon width={12} height={12} /> unconfirmed
        </span>
      ) : null}
    </li>
  );
}

export default function PostsPage() {
  const storage = useStorageMode();
  const [posts, setPosts] = useState<StoredPost[] | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>("all");
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setPosts(await callApi<StoredPost[]>("/posts", { signal }));
      setLoadError(undefined);
    } catch (error) {
      if (!signal?.aborted) setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, refreshMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const counts = useMemo(() => {
    const totals: Record<Filter, number> = { all: 0, draft: 0, scheduled: 0, publishing: 0, published: 0, failed: 0, cancelled: 0 };
    for (const post of posts ?? []) {
      totals.all += 1;
      totals[post.status] += 1;
    }
    return totals;
  }, [posts]);
  const visible = (posts ?? []).filter((post) => filter === "all" || post.status === filter);

  const replace = (updated: StoredPost) => setPosts((items) => items?.map((item) => (item.id === updated.id ? updated : item)));

  const run = async (post: StoredPost, action: () => Promise<Notice>) => {
    setPending(post.id);
    setNotice(undefined);
    try {
      setNotice(await action());
    } catch (error) {
      // A 409 carries the post as it is now (e.g. the worker already published it).
      if (error instanceof ApiError && error.post) replace(error.post);
      setNotice({ message: errorMessage(error), tone: "error" });
    } finally {
      setPending(undefined);
      void refresh();
    }
  };

  const publish = (post: StoredPost) => {
    const targets = remainingPlatforms(post);
    if (!window.confirm(`Publish this post to ${labels(targets)} now?`)) return;
    void run(post, async () => {
      const { post: settled, results } = await callApi<PublishNowResponse>(`/posts/${encodeURIComponent(post.id)}/publish`, { method: "POST" });
      replace(settled);
      const failed = results.filter((result) => result.status === "failed");
      return failed.length
        ? { message: `Publishing to ${labels(failed.map((result) => result.platform))} failed — see the post for the error.`, tone: "error" }
        : { message: `Published to ${labels(results.map((result) => result.platform))}.`, tone: "success" };
    });
  };

  const cancel = (post: StoredPost) => {
    const draft = post.status === "draft";
    if (!window.confirm(draft ? "Discard this draft?" : "Cancel this post? It will not be published.")) return;
    void run(post, async () => {
      replace(await callApi<StoredPost>(`/posts/${encodeURIComponent(post.id)}/cancel`, { method: "POST" }));
      return { message: draft ? "Draft discarded." : "Post cancelled.", tone: "success" };
    });
  };

  return (
    <main className="space-y-6">
      <section className="card flex flex-wrap items-start gap-4 bg-gradient-to-br from-brand/10 to-transparent">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Posts</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Drafts, the publishing queue and history. Open a post in the composer to edit it, publish it now, or cancel it before it goes out.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            <RefreshIcon width={16} height={16} /> Refresh
          </button>
          <Link href="/" className="btn-primary">
            <PlusIcon width={16} height={16} /> New post
          </Link>
        </div>
      </section>

      <StorageNotice mode={storage} />

      <div role="group" aria-label="Filter posts by status" className="flex flex-wrap gap-2">
        {filters.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={`btn border px-3 py-1.5 text-xs ${
              filter === id ? "border-brand bg-brand/10 text-ink" : "border-edge bg-surface text-ink-muted hover:bg-surface-muted"
            }`}
          >
            {label}
            <span className="rounded-full bg-surface-muted px-1.5 text-[11px] tabular-nums">{counts[id]}</span>
          </button>
        ))}
      </div>

      <div role="status" aria-live="polite">
        {notice ? (
          <p className={`card py-3 text-sm ${notice.tone === "error" ? "border-rose-500/40 text-rose-500" : "border-emerald-500/40 text-emerald-600"}`}>
            {notice.message}
          </p>
        ) : null}
      </div>

      {loadError ? (
        <p className="card flex items-start gap-2 border-rose-500/40 py-3 text-sm text-rose-500">
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            {loadError} at <code className="font-mono text-xs">{apiUrl}</code>. Check that it is running —{" "}
            <Link href="/setup" className="font-medium underline-offset-2 hover:underline">
              see Setup
            </Link>
            .
          </span>
        </p>
      ) : null}

      {posts === undefined ? (
        loadError ? null : <p className="card text-sm text-ink-muted">Loading posts…</p>
      ) : visible.length === 0 ? (
        <div className="card text-center text-sm text-ink-muted">
          {filter === "all" ? (
            <>
              No posts yet.{" "}
              <Link href="/" className="font-medium text-brand underline-offset-2 hover:underline">
                Write your first one
              </Link>
              .
            </>
          ) : (
            `No ${filters.find((item) => item.id === filter)?.label.toLowerCase()} posts.`
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((post) => {
            const busy = pending === post.id;
            const targets = remainingPlatforms(post);
            return (
              <article key={post.id} className="card space-y-3 p-5" aria-busy={busy}>
                <header className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={post.status} />
                  <span className="text-xs text-ink-muted">{timeline(post)}</span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {isEditable(post.status) ? (
                      <>
                        <Link href={`/?post=${encodeURIComponent(post.id)}`} className="btn-ghost px-3 py-1.5 text-xs">
                          <PencilIcon width={14} height={14} /> Edit
                        </Link>
                        <button
                          type="button"
                          className="btn-primary px-3 py-1.5 text-xs"
                          disabled={busy || targets.length === 0}
                          title={targets.length === 0 ? "Pick platforms in the composer first" : undefined}
                          onClick={() => publish(post)}
                        >
                          <SendIcon width={14} height={14} /> {busy ? "Working…" : post.status === "failed" ? "Retry" : "Publish now"}
                        </button>
                        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => cancel(post)}>
                          <XIcon width={14} height={14} /> {post.status === "draft" ? "Discard" : "Cancel"}
                        </button>
                      </>
                    ) : post.status === "publishing" ? null : (
                      <Link href={`/?post=${encodeURIComponent(post.id)}`} className="btn-ghost px-3 py-1.5 text-xs">
                        <CopyIcon width={14} height={14} /> Copy to new post
                      </Link>
                    )}
                  </div>
                </header>
                <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {post.text || <span className="italic text-ink-muted">No text</span>}
                </p>
                {post.media.length > 0 ? (
                  <p className="text-xs text-ink-muted">
                    {post.media.length} attachment{post.media.length === 1 ? "" : "s"}
                  </p>
                ) : null}
                {post.platforms.length > 0 ? (
                  <ul className="flex flex-wrap gap-2" aria-label="Platforms">
                    {post.platforms.map((platform) => (
                      <PlatformChip key={platform} post={post} platform={platform} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-muted">No platforms picked yet.</p>
                )}
                {post.lastError && post.status !== "published" ? (
                  <p className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-300">
                    <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
                    <span className="break-words">{post.lastError}</span>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
