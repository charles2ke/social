"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { apiUrl } from "./config";
import { AlertIcon, CheckIcon, LinkIcon, PlatformIcon, PlusIcon, TrashIcon } from "./icons";
import { platformIds, platformMeta } from "./platforms";
import { inferMediaKind, isHttpUrl, safeMediaSrc, type MediaAttachment } from "./media";

type Compatibility = { platform: string; compatible: boolean; reason?: string };
type PublishResult = { platform: string; status: "published" | "failed"; url?: string; error?: string };

export default function Dashboard() {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(["instagram"]);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [altText, setAltText] = useState("");
  const [warnings, setWarnings] = useState<Compatibility[]>([]);
  const [results, setResults] = useState<PublishResult[]>([]);
  const [status, setStatus] = useState("");

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
    if (!url) return;
    if (!isHttpUrl(url)) { setStatus("Media URLs must start with http:// or https://"); return; }
    const kind = inferMediaKind(url);
    if (!kind) { setStatus("Media URL must end in a known image or video extension"); return; }
    if (media.some((item) => item.url === url)) { setStatus("That attachment was already added"); return; }
    setMedia((items) => [...items, { url, kind, altText: altText.trim() || undefined }]);
    setMediaUrl(""); setAltText(""); setStatus("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setStatus("Publishing…"); setResults([]);
    try {
      const response = await fetch(`${apiUrl}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, platforms: selected, media }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) { setStatus((body as { error?: string })?.error ?? `Publishing failed (${response.status})`); return; }
      setResults(Array.isArray(body) ? (body as PublishResult[]) : []); setStatus("");
    } catch { setStatus("Could not reach the API"); }
  };

  return (
    <main className="space-y-6">
      <section className="card bg-gradient-to-br from-brand/10 to-transparent">
        <h1 className="text-2xl font-bold tracking-tight">Compose once, publish everywhere</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Draft a post, attach media, and fan it out to every connected platform. New here?{" "}
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
          <h2 className="text-lg font-semibold">Publish to</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {platformIds.map((platform) => {
              const meta = platformMeta(platform);
              const checked = selected.includes(platform);
              return (
                <label
                  key={platform}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                    checked ? "border-brand bg-brand/10" : "border-edge hover:bg-surface-muted"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() =>
                      setSelected((items) => (items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform]))
                    }
                  />
                  <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}>
                    <PlatformIcon platform={platform} width={18} height={18} />
                  </span>
                  <span className="text-sm font-medium">{meta.label}</span>
                  {checked ? <CheckIcon width={16} height={16} className="ml-auto text-brand" /> : null}
                </label>
              );
            })}
          </div>
          <button type="submit" className="btn-primary w-full sm:w-auto">Publish now</button>
        </section>
      </form>

      <div role="status" aria-live="polite" className="space-y-3">
        {status ? <p className="card py-3 text-sm">{status}</p> : null}
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
