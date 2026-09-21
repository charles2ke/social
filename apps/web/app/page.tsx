"use client";
import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { apiUrl } from "./config";
import { AlertIcon, CheckIcon, ClockIcon, LinkIcon, PlatformIcon, PlusIcon, TrashIcon } from "./icons";
import { platformIds, platformMeta, publishablePlatformIds } from "./platforms";
import { inferMediaKind, isHttpUrl, safeMediaSrc, type MediaAttachment } from "./media";

type Compatibility = { platform: string; compatible: boolean; reason?: string };
type PublishResult = { platform: string; status: "published" | "failed"; url?: string; error?: string };
type Status = { message: string; tone: "info" | "error" | "success" };

/** `datetime-local` needs a local `YYYY-MM-DDTHH:mm` value, not the UTC string `toISOString()` returns. */
function toLocalInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function Dashboard() {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(["instagram"]);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [altText, setAltText] = useState("");
  const [warnings, setWarnings] = useState<Compatibility[]>([]);
  const [results, setResults] = useState<PublishResult[]>([]);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [later, setLater] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/media/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", media }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : []))
      // Warn only about the platforms the user actually publishes to; an empty list can still be incompatible (e.g. media-required platforms).
      .then((result: Compatibility[]) =>
        setWarnings(Array.isArray(result) ? result.filter((item) => !item.compatible && selected.includes(item.platform)) : []),
      )
      .catch(() => setWarnings([]));
    return () => controller.abort();
  }, [media, selected]);

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

    setBusy(true); setResults([]); setStatus({ message: when ? "Scheduling…" : "Publishing…", tone: "info" });
    try {
      const response = await fetch(`${apiUrl}${when ? "/schedule" : "/publish"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, platforms: selected, media, ...(when ? { scheduledFor: when.toISOString() } : {}) }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        setStatus({ message: (body as { error?: string })?.error ?? `${when ? "Scheduling" : "Publishing"} failed (${response.status})`, tone: "error" });
        return;
      }
      if (when) {
        setStatus({ message: `Queued for ${when.toLocaleString()} — the scheduler worker publishes it.`, tone: "success" });
        return;
      }
      setResults(Array.isArray(body) ? (body as PublishResult[]) : []); setStatus(undefined);
    } catch { setStatus({ message: "Could not reach the API", tone: "error" }); }
    finally { setBusy(false); }
  };

  return (
    <main className="space-y-6">
      <section className="card bg-gradient-to-br from-brand/10 to-transparent">
        <h1 className="text-2xl font-bold tracking-tight">Compose once, publish everywhere</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Draft a post, attach media, and fan it out to every connected platform — right now or on a schedule. New here?{" "}
          <Link href="/setup" className="font-medium text-brand underline-offset-2 hover:underline">
            Finish setup
          </Link>
          .
        </p>
      </section>

      <form onSubmit={submit} className="space-y-6">
        <section className="card space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Post</h2>
            <span className={`text-xs ${text.length > 2900 ? "text-amber-500" : "text-ink-muted"}`}>{text.length}/3000</span>
          </div>
          <textarea
            aria-label="Post text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={3000}
            placeholder="Share an update…"
            required
            className="field min-h-40 resize-y leading-relaxed"
          />
        </section>

        <section className="card space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Images &amp; videos</h2>
            <p className="text-sm text-ink-muted">Attach media by URL — the API validates it against each platform&apos;s limits.</p>
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
                    onClick={() => setMedia((items) => items.filter((existing) => existing.url !== item.url))}
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

          {warnings.length > 0 && (
            <ul className="space-y-2">
              {warnings.map((item) => (
                <li key={item.platform} className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <AlertIcon width={16} height={16} className="mt-0.5 shrink-0 text-amber-500" />
                  <span>{item.reason}</span>
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
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
                  Queued in Postgres and published by the scheduler worker, in your local time zone.
                </span>
              </label>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn-primary w-full sm:w-auto" disabled={busy || selected.length === 0}>
              {busy ? (later ? "Scheduling…" : "Publishing…") : later ? "Schedule post" : "Publish now"}
            </button>
            {selected.length === 0 ? <span className="text-sm text-ink-muted">Pick at least one platform first.</span> : null}
          </div>
        </section>
      </form>

      <div role="status" aria-live="polite" className="space-y-3">
        {status ? (
          <p
            className={`card py-3 text-sm ${
              status.tone === "error" ? "border-rose-500/40 text-rose-500" : status.tone === "success" ? "border-emerald-500/40 text-emerald-600" : ""
            }`}
          >
            {status.message}
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
