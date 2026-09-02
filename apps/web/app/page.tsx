"use client";
import { FormEvent, useEffect, useState } from "react";
import { inferMediaKind, isHttpUrl, type MediaAttachment } from "./media";
const platforms = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"];
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
type Compatibility = { platform: string; compatible: boolean; reason?: string };
export default function Dashboard() {
  const [text, setText] = useState(""); const [selected, setSelected] = useState(["instagram"]);
  const [media, setMedia] = useState<MediaAttachment[]>([]); const [mediaUrl, setMediaUrl] = useState(""); const [altText, setAltText] = useState("");
  const [warnings, setWarnings] = useState<Compatibility[]>([]); const [status, setStatus] = useState("");
  useEffect(() => {
    if (!media.length) { setWarnings([]); return; }
    const controller = new AbortController();
    fetch(`${apiUrl}/media/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "", media }), signal: controller.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((result: Compatibility[]) => setWarnings(Array.isArray(result) ? result.filter((item) => !item.compatible) : []))
      .catch(() => setWarnings([]));
    return () => controller.abort();
  }, [media]);
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
    event.preventDefault();
    const response = await fetch(`${apiUrl}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, platforms: selected, media }) });
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) { setStatus((result as { error?: string })?.error ?? "Publishing failed"); return; }
    const failed = (Array.isArray(result) ? result : []).filter((item: { status?: string }) => item.status === "failed");
    setStatus(failed.length ? failed.map((item: { platform: string; error: string }) => `${item.platform}: ${item.error}`).join(" · ") : "Post queued for publishing");
  };
  return <main><header><h1>Social</h1><p>Self-hosted social media manager</p></header><section><h2>Compose</h2><form onSubmit={submit}><textarea aria-label="Post text" value={text} onChange={(e) => setText(e.target.value)} maxLength={3000} placeholder="Share an update…" required /><p>{text.length}/3000 characters</p>
    <fieldset><legend>Images &amp; videos</legend>
      <label htmlFor="media-url">Media URL</label> <input id="media-url" type="url" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://cdn.example.com/clip.mp4" />
      <label htmlFor="media-alt">Alt text</label> <input id="media-alt" type="text" value={altText} onChange={(e) => setAltText(e.target.value)} placeholder="Describe the image or video" />
      <button type="button" onClick={addMedia}>Add media</button>
      {media.length > 0 && <ul className="media-list">{media.map((item) => <li key={item.url}>
        {item.kind === "image" ? <img src={item.url} alt={item.altText ?? ""} /> : <video src={item.url} controls aria-label={item.altText ?? item.url} />}
        <span>{item.kind}</span> <span className="media-url">{item.url}</span>
        <button type="button" onClick={() => setMedia((items) => items.filter((existing) => existing.url !== item.url))}>Remove</button>
      </li>)}</ul>}
      {warnings.length > 0 && <ul className="media-warnings">{warnings.map((item) => <li key={item.platform}>{item.reason}</li>)}</ul>}
    </fieldset>
    <fieldset><legend>Publish to</legend>{platforms.map((platform) => <label key={platform}><input type="checkbox" checked={selected.includes(platform)} onChange={() => setSelected((items) => items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform])} /> {platform}</label>)}</fieldset>
    <button type="submit">Publish now</button>{status && <p role="status">{status}</p>}</form></section><section><h2>Upcoming</h2><p>Schedule posts through the API or MCP server. Mock mode includes demo accounts.</p></section></main>;
}
