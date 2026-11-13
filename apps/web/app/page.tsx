"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, KeyboardEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertIcon, CheckIcon, ClockIcon, LinkIcon, PlatformIcon, PlusIcon, TrashIcon } from "./icons";
import { platformIds, platformMeta, publishablePlatformIds } from "./platforms";
import { inferMediaKind, isHttpUrl, safeMediaSrc, type MediaAttachment } from "./media";
import {
  ApiError,
  callApi,
  errorMessage,
  isEditable,
  type PlatformOverride,
  type PostStatus,
  type PublishNowResponse,
  type PublishResult,
  type StoredPost,
} from "./posts";
import { StatusBadge } from "./components/post-status";
import { LimitChips, PlatformVersion } from "./components/platform-version";
import { StorageNotice, useStorageMode } from "./components/storage-notice";
import { limitChips, type TextLimit } from "./text";

/** One platform's answer from `POST /validate`. */
type DraftCheck = { platform: string; problems: string[] };
/** Per-platform versions of the post, keyed by platform. An entry that sets nothing is customized but still matches the post. */
type Overrides = Record<string, PlatformOverride>;
/** `postsLink` appends a link to the Posts page, where the saved post can be found. */
type Status = { message: string; tone: "info" | "warning" | "error" | "success"; postsLink?: boolean };
type Action = "loading" | "saving" | "publishing" | "scheduling";

const defaultPlatforms = ["instagram"];
/** Waits for a pause in typing before asking the API to check the draft. */
const validateDelayMs = 400;

const editingHints: Partial<Record<PostStatus, string>> = {
  draft: "Editing a saved draft.",
  scheduled: "Editing a scheduled post — changes apply when you update the schedule.",
  failed: "Editing a failed post — publishing again skips the platforms that already succeeded.",
};

/** `datetime-local` needs a local `YYYY-MM-DDTHH:mm` value, not the UTC string `toISOString()` returns. */
function toLocalInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** True when a platform's version changes something; a customized platform that changes nothing publishes the post as is. */
const changesPost = (override: PlatformOverride | undefined): override is PlatformOverride =>
  Boolean(override && (override.text !== undefined || override.media !== undefined));

/**
 * Reports the `?post=<id>` the composer should open. `useSearchParams` opts
 * its subtree out of static prerendering, so it sits in its own Suspense
 * boundary and the rest of the composer still prerenders.
 */
function PostParam({ onChange }: { onChange: (id: string | null) => void }) {
  const id = useSearchParams().get("post");
  useEffect(() => {
    onChange(id);
  }, [id, onChange]);
  return null;
}

export default function Dashboard() {
  const router = useRouter();
  const storage = useStorageMode();
  /** The stored post being edited; unset while composing a new one. */
  const [post, setPost] = useState<{ id: string; status: PostStatus } | undefined>(undefined);
  // Tracks the post id synchronously, so the composer's own URL updates are not mistaken for navigation.
  const currentId = useRef<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(defaultPlatforms);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [altText, setAltText] = useState("");
  const [overrides, setOverrides] = useState<Overrides>({});
  const [textLimits, setTextLimits] = useState<Record<string, TextLimit[]>>({});
  /** Problems per platform from the last `/validate`; undefined while there is nothing to check. */
  const [problems, setProblems] = useState<Record<string, string[]> | undefined>(undefined);
  const [results, setResults] = useState<PublishResult[]>([]);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [later, setLater] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState<Action | undefined>(undefined);

  const chosenPlatforms = useMemo(() => platformIds.filter((platform) => selected.includes(platform)), [selected]);
  /** The per-platform versions saving or publishing sends: those of the chosen platforms that change something. */
  const versions = useMemo(() => {
    const chosen: Overrides = {};
    for (const platform of chosenPlatforms) if (changesPost(overrides[platform])) chosen[platform] = overrides[platform];
    return chosen;
  }, [chosenPlatforms, overrides]);
  const hasContent = Boolean(text.trim() || media.length || Object.values(versions).some((version) => version.text?.trim() || version.media?.length));

  useEffect(() => {
    const controller = new AbortController();
    callApi<{ id: string; textLimits?: TextLimit[] }[]>("/platforms", { signal: controller.signal })
      .then((list) => setTextLimits(Object.fromEntries(list.map((platform) => [platform.id, platform.textLimits ?? []]))))
      // Without the limits the composer only loses its counters; the API still checks every draft.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Asks the API what would fail on each chosen platform, once typing pauses; nothing is flagged before there is content.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        if (!hasContent || chosenPlatforms.length === 0) { setProblems(undefined); return; }
        callApi<DraftCheck[]>("/validate", {
          body: { text, media, platforms: chosenPlatforms, perPlatformOverrides: versions },
          signal: controller.signal,
        })
          .then((checks) => setProblems(Object.fromEntries(checks.map((check) => [check.platform, check.problems]))))
          .catch(() => { if (!controller.signal.aborted) setProblems(undefined); });
      },
      hasContent ? validateDelayMs : 0,
    );
    return () => { clearTimeout(timer); controller.abort(); };
  }, [hasContent, text, media, chosenPlatforms, versions]);

  const updateOverride = (platform: string, update: (override: PlatformOverride) => PlatformOverride | undefined) =>
    setOverrides((current) => {
      const { [platform]: existing, ...others } = current;
      const next = update(existing ?? {});
      return next ? { ...others, [platform]: next } : others;
    });

  /** Picks which of the attachments a customized platform publishes; picking all of the post's, in order, follows the post again. */
  const toggleMedia = (platform: string, url: string) =>
    updateOverride(platform, (override) => {
      const options = [...media, ...(override.media ?? []).filter((item) => !media.some((main) => main.url === item.url))];
      const chosen = new Set((override.media ?? media).map((item) => item.url));
      if (chosen.has(url)) chosen.delete(url); else chosen.add(url);
      const next = options.filter((item) => chosen.has(item.url));
      const followsPost = next.length === media.length && next.every((item, index) => item.url === media[index].url);
      return { ...(override.text !== undefined ? { text: override.text } : {}), ...(followsPost ? {} : { media: next }) };
    });

  const removeMedia = (url: string) => {
    setMedia((items) => items.filter((existing) => existing.url !== url));
    // A removed attachment is gone from every platform's version too.
    setOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).map(([platform, override]) => [
          platform,
          override.media ? { ...override, media: override.media.filter((item) => item.url !== url) } : override,
        ]),
      ),
    );
  };

  const addMedia = () => {
    const url = mediaUrl.trim();
    if (!url) { setStatus({ message: "Enter a media URL first", tone: "error" }); return; }
    if (!isHttpUrl(url)) { setStatus({ message: "Media URLs must start with http:// or https://", tone: "error" }); return; }
    const kind = inferMediaKind(url);
    if (!kind) { setStatus({ message: "Media URL must end in a known image or video extension", tone: "error" }); return; }
    if (media.some((item) => item.url === url)) { setStatus({ message: "That attachment was already added", tone: "error" }); return; }
    setMedia((items) => [...items, { url, kind, altText: altText.trim() || undefined }]);
    setMediaUrl(""); setAltText(""); setStatus(undefined);
  };

  // Enter inside the media fields should attach the media, not submit the whole composer.
  const mediaKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addMedia();
  };

  /** Points the composer (and its URL) at a stored post, or back at a new one. */
  const track = useCallback(
    (stored: StoredPost | undefined) => {
      currentId.current = stored?.id;
      setPost(stored ? { id: stored.id, status: stored.status } : undefined);
      router.replace(stored ? `/?post=${encodeURIComponent(stored.id)}` : "/", { scroll: false });
    },
    [router],
  );

  const resetForm = useCallback(() => {
    setText(""); setMedia([]); setMediaUrl(""); setAltText(""); setOverrides({}); setSelected(defaultPlatforms);
    setLater(false); setScheduledFor(""); setResults([]); setStatus(undefined);
  }, []);

  const load = useCallback(
    async (id: string) => {
      currentId.current = id;
      setBusy("loading"); setResults([]); setStatus({ message: "Loading the post…", tone: "info" });
      try {
        const stored = await callApi<StoredPost>(`/posts/${encodeURIComponent(id)}`);
        if (currentId.current !== id) return;
        setText(stored.text); setMedia(stored.media); setOverrides(stored.perPlatformOverrides ?? {});
        setSelected(stored.platforms.filter((platform) => publishablePlatformIds.includes(platform)));
        const scheduled = stored.status === "scheduled" && stored.scheduledFor ? new Date(stored.scheduledFor) : undefined;
        setLater(Boolean(scheduled)); setScheduledFor(scheduled ? toLocalInputValue(scheduled) : "");
        if (isEditable(stored.status)) {
          setPost({ id: stored.id, status: stored.status }); setStatus(undefined);
          return;
        }
        // A published, cancelled or in-flight post cannot change, so its content starts a new post instead.
        track(undefined);
        setStatus({ message: `That post is ${stored.status}, so it was copied into a new post.`, tone: "info" });
      } catch (error) {
        if (currentId.current !== id) return;
        track(undefined);
        setStatus({ message: error instanceof ApiError && error.status === 404 ? "That post no longer exists." : errorMessage(error), tone: "error" });
      } finally {
        setBusy(undefined);
      }
    },
    [track],
  );

  const onPostParam = useCallback(
    (id: string | null) => {
      if ((id ?? undefined) === currentId.current) return;
      if (id) { void load(id); return; }
      // Navigated back to a bare "/" (e.g. the Composer link) while editing: start a new post.
      currentId.current = undefined; setPost(undefined); resetForm();
    },
    [load, resetForm],
  );

  const startNew = () => { track(undefined); resetForm(); };

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409 && error.post && !isEditable(error.post.status)) {
      // Someone else (usually the scheduler worker) moved the post on; keep the edits as a new post rather than lose them.
      track(undefined);
      setStatus({ message: `${error.message}, so your edits are kept here as a new post.`, tone: "error", postsLink: true });
      return;
    }
    setStatus({ message: errorMessage(error), tone: "error" });
  };

  const saveDraft = async () => {
    if (busy) return;
    if (!text.trim() && media.length === 0) { setStatus({ message: "Write something or attach media before saving", tone: "error" }); return; }
    setBusy("saving"); setResults([]); setStatus({ message: "Saving…", tone: "info" });
    try {
      const content = { text, media, platforms: selected, perPlatformOverrides: versions };
      const saved = post
        ? await callApi<StoredPost>(`/drafts/${encodeURIComponent(post.id)}`, { body: content })
        : await callApi<StoredPost>("/drafts", { body: content });
      track(saved);
      setStatus({ message: post ? "Changes saved." : "Draft saved.", tone: "success", postsLink: true });
    } catch (error) { fail(error); }
    finally { setBusy(undefined); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (selected.length === 0) { setStatus({ message: "Choose at least one platform to publish to", tone: "error" }); return; }

    let when: Date | undefined;
    if (later) {
      when = new Date(scheduledFor);
      if (!scheduledFor || Number.isNaN(when.getTime())) { setStatus({ message: "Pick the date and time to publish", tone: "error" }); return; }
      if (when.getTime() <= Date.now()) { setStatus({ message: "Pick a time in the future, or publish now", tone: "error" }); return; }
    }

    setBusy(when ? "scheduling" : "publishing"); setResults([]); setStatus({ message: when ? "Scheduling…" : "Publishing…", tone: "info" });
    const content = { text, media, platforms: selected, perPlatformOverrides: versions };
    try {
      if (when) {
        const scheduled = await callApi<StoredPost>("/schedule", {
          body: { ...content, scheduledFor: when.toISOString(), ...(post ? { id: post.id } : {}) },
        });
        track(scheduled);
        setStatus(
          storage === "memory"
            ? { message: `Saved for ${when.toLocaleString()}, but this API keeps posts in memory, so it will not be published.`, tone: "warning", postsLink: true }
            : { message: `Queued for ${when.toLocaleString()} — the scheduler worker publishes it.`, tone: "success", postsLink: true },
        );
        return;
      }
      // Publishing goes through a stored post, so it shows up in Posts and a failed platform can be retried.
      let target = post;
      if (!target) {
        const created = await callApi<StoredPost>("/drafts", { body: content });
        track(created);
        target = created;
      }
      const published = await callApi<PublishNowResponse>(`/posts/${encodeURIComponent(target.id)}/publish`, { body: content });
      setResults(published.results);
      if (published.post.status === "published") {
        track(undefined);
        setStatus({ message: "Published.", tone: "success", postsLink: true });
      } else {
        track(published.post);
        setStatus({
          message: "Some platforms failed, so the post was saved as failed. Fix it and publish again — platforms that already succeeded are skipped.",
          tone: "error",
          postsLink: true,
        });
      }
    } catch (error) { fail(error); }
    finally { setBusy(undefined); }
  };

  const primaryLabel =
    busy === "scheduling" ? "Scheduling…" : busy === "publishing" ? "Publishing…" : later ? (post?.status === "scheduled" ? "Update schedule" : "Schedule post") : "Publish now";

  return (
    <main className="space-y-6">
      <section className="card bg-gradient-to-br from-brand/10 to-transparent">
        <h1 className="text-2xl font-bold tracking-tight">Compose once, publish everywhere</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Draft a post, attach media, and fan it out to every connected platform — right now or on a schedule. Saved drafts, the queue and
          history live in{" "}
          <Link href="/posts" className="font-medium text-brand underline-offset-2 hover:underline">
            Posts
          </Link>
          . New here?{" "}
          <Link href="/setup" className="font-medium text-brand underline-offset-2 hover:underline">
            Finish setup
          </Link>
          .
        </p>
      </section>

      <Suspense fallback={null}>
        <PostParam onChange={onPostParam} />
      </Suspense>

      {post ? (
        <section className="card flex flex-wrap items-center gap-3 py-3" aria-label="Editing a saved post">
          <StatusBadge status={post.status} />
          <p className="text-sm text-ink-muted">{editingHints[post.status]}</p>
          <button type="button" onClick={startNew} className="btn-ghost ml-auto px-3 py-1.5 text-xs" disabled={Boolean(busy)}>
            <PlusIcon width={14} height={14} /> New post
          </button>
        </section>
      ) : null}

      <form onSubmit={submit} className="space-y-6">
        <section className="card space-y-3">
          <h2 className="text-lg font-semibold">Post</h2>
          <textarea
            aria-label="Post text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Share an update…"
            required
            className="field min-h-40 resize-y leading-relaxed"
          />
          {/* Customized platforms count their own text, under Publish to. */}
          <LimitChips
            chips={chosenPlatforms
              .filter((platform) => overrides[platform]?.text === undefined)
              .flatMap((platform) => limitChips(textLimits[platform] ?? [], text, `${platformMeta(platform).label} `))}
            label="Text limits"
          />
        </section>

        <section className="card space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Images &amp; videos</h2>
            <p className="text-sm text-ink-muted">
              Attach media by URL. Anything a platform cannot publish is flagged under Per-platform versions.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Media URL
              <input
                type="url"
                value={mediaUrl}
                onChange={(event) => setMediaUrl(event.target.value)}
                onKeyDown={mediaKeyDown}
                placeholder="https://cdn.example.com/clip.mp4"
                className="field mt-1 font-normal"
              />
            </label>
            <label className="block text-sm font-medium">
              Alt text
              <input
                type="text"
                value={altText}
                onChange={(event) => setAltText(event.target.value)}
                onKeyDown={mediaKeyDown}
                placeholder="Describe the image or video"
                className="field mt-1 font-normal"
              />
            </label>
          </div>
          <button type="button" onClick={addMedia} className="btn-ghost">
            <PlusIcon width={16} height={16} /> Add media
          </button>

          {media.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2">
              {media.map((item) => (
                <li key={item.url} className="flex items-center gap-3 rounded-xl border border-edge bg-surface-muted p-3">
                  {item.kind === "image" ? (
                    <img src={safeMediaSrc(item.url)} alt={item.altText ?? ""} className="h-16 w-16 rounded-lg object-cover" />
                  ) : (
                    <video src={safeMediaSrc(item.url)} controls aria-label={item.altText ?? item.url} className="h-16 w-16 rounded-lg object-cover" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="badge">{item.kind}</span>
                    <p className="mt-1 break-all text-xs text-ink-muted">{item.url}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeMedia(item.url)}
                    className="btn-ghost px-2 py-2"
                    title={`Remove ${item.url}`}
                  >
                    <TrashIcon width={16} height={16} />
                    <span className="sr-only">Remove attachment</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              Publish to <span className="text-sm font-normal text-ink-muted">({selected.length} selected)</span>
            </h2>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSelected([...publishablePlatformIds])}>
                Select all
              </button>
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSelected([])} disabled={selected.length === 0}>
                Clear
              </button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Platforms">
            {platformIds.map((platform) => {
              const meta = platformMeta(platform);
              const checked = selected.includes(platform);
              // Snapchat and Substack have no publishing API, so offering them would only queue a guaranteed failure.
              const unsupported = Boolean(meta.unsupported);
              return (
                <label
                  key={platform}
                  title={meta.unsupported}
                  className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                    unsupported
                      ? "cursor-not-allowed border-edge opacity-60"
                      : checked
                        ? "cursor-pointer border-brand bg-brand/10"
                        : "cursor-pointer border-edge hover:bg-surface-muted"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    disabled={unsupported}
                    onChange={() =>
                      setSelected((items) => (items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform]))
                    }
                  />
                  <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}>
                    <PlatformIcon platform={platform} width={18} height={18} />
                  </span>
                  <span className="text-sm font-medium">{meta.label}</span>
                  {unsupported ? (
                    <span className="ml-auto text-xs text-ink-muted">No API</span>
                  ) : checked ? (
                    <CheckIcon width={16} height={16} className="ml-auto text-brand" />
                  ) : null}
                </label>
              );
            })}
          </div>
          {chosenPlatforms.length > 0 ? (
            <div className="space-y-3 border-t border-edge pt-4">
              <div>
                <h3 className="text-sm font-semibold">Per-platform versions</h3>
                <p className="text-xs text-ink-muted">Every platform publishes the post above unless you customize its text or attachments.</p>
              </div>
              <ul className="space-y-2" aria-label="Per-platform versions">
                {chosenPlatforms.map((platform) => (
                  <PlatformVersion
                    key={platform}
                    platform={platform}
                    override={overrides[platform]}
                    text={text}
                    media={media}
                    limits={textLimits[platform] ?? []}
                    problems={problems?.[platform]}
                    disabled={Boolean(busy)}
                    onCustomize={() => updateOverride(platform, (override) => override)}
                    onReset={() => updateOverride(platform, () => undefined)}
                    onTextChange={(value) => updateOverride(platform, (override) => ({ ...override, text: value }))}
                    onToggleMedia={(url) => toggleMedia(platform, url)}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          <div className="space-y-3 border-t border-edge pt-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={later} onChange={(event) => setLater(event.target.checked)} className="h-4 w-4 accent-brand" />
              <ClockIcon width={16} height={16} className="text-ink-muted" />
              Schedule for later
            </label>
            {later ? (
              <label className="block text-sm font-medium sm:max-w-xs">
                Publish at
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  min={toLocalInputValue(new Date())}
                  onChange={(event) => setScheduledFor(event.target.value)}
                  className="field mt-1 font-normal"
                />
                <span className="mt-1 block text-xs font-normal text-ink-muted">
                  {storage === "postgres"
                    ? "Queued in Postgres and published by the scheduler worker, in your local time zone."
                    : "In your local time zone; the scheduler worker publishes it."}
                </span>
              </label>
            ) : null}
            {later ? <StorageNotice mode={storage} /> : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary w-full sm:w-auto" disabled={Boolean(busy) || selected.length === 0}>
              {primaryLabel}
            </button>
            {/* A scheduled post is saved through "Update schedule", which keeps its content and time together. */}
            {post?.status !== "scheduled" ? (
              <button type="button" onClick={saveDraft} className="btn-ghost w-full sm:w-auto" disabled={Boolean(busy)}>
                {busy === "saving" ? "Saving…" : post?.status === "failed" ? "Save changes" : "Save draft"}
              </button>
            ) : null}
            {selected.length === 0 ? <span className="text-sm text-ink-muted">Pick at least one platform first.</span> : null}
          </div>
        </section>
      </form>

      <div role="status" aria-live="polite" className="space-y-3">
        {status ? (
          <p
            className={`card py-3 text-sm ${
              status.tone === "error"
                ? "border-rose-500/40 text-rose-500"
                : status.tone === "warning"
                  ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                  : status.tone === "success"
                    ? "border-emerald-500/40 text-emerald-600"
                    : ""
            }`}
          >
            {status.message}
            {status.postsLink ? (
              <>
                {" "}
                <Link href="/posts" className="font-medium text-brand underline-offset-2 hover:underline">
                  View in Posts
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {results.length > 0 && (
          <ul className="card divide-y divide-edge p-0">
            {results.map((result) => (
              <li key={result.platform} className="flex items-center gap-3 p-4 text-sm">
                <PlatformIcon platform={result.platform} width={18} height={18} className="text-ink-muted" />
                <span className="font-medium">{platformMeta(result.platform).label}</span>
                {result.status === "published" ? (
                  <span className="ml-auto flex items-center gap-2 text-emerald-500">
                    <CheckIcon width={16} height={16} /> published
                    {result.url ? (
                      <a href={result.url} className="flex items-center gap-1 text-brand hover:underline">
                        <LinkIcon width={14} height={14} /> view
                      </a>
                    ) : null}
                  </span>
                ) : (
                  <span className="ml-auto flex items-center gap-2 text-rose-500">
                    <AlertIcon width={16} height={16} /> failed — {result.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
