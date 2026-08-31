"use client";
import { FormEvent, useState } from "react";
const platforms = ["instagram", "facebook", "whatsapp", "linkedin", "substack", "youtube", "snapchat", "tiktok", "strava"];
export default function Dashboard() {
  const [text, setText] = useState(""); const [selected, setSelected] = useState(["instagram"]);
  const submit = async (event: FormEvent) => { event.preventDefault(); await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, platforms: selected }) }); alert("Post queued for publishing"); };
  return <main><header><h1>Social</h1><p>Self-hosted social media manager</p></header><section><h2>Compose</h2><form onSubmit={submit}><textarea aria-label="Post text" value={text} onChange={(e) => setText(e.target.value)} maxLength={3000} placeholder="Share an update…" required /><p>{text.length}/3000 characters</p><fieldset><legend>Publish to</legend>{platforms.map((platform) => <label key={platform}><input type="checkbox" checked={selected.includes(platform)} onChange={() => setSelected((items) => items.includes(platform) ? items.filter((item) => item !== platform) : [...items, platform])} /> {platform}</label>)}</fieldset><button type="submit">Publish now</button></form></section><section><h2>Upcoming</h2><p>Schedule posts through the API or MCP server. Mock mode includes demo accounts.</p></section></main>;
}
