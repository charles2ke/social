"use client";
import { useEffect, useState } from "react";
import { apiUrl } from "../config";
import { AlertIcon, CheckIcon, LinkIcon, PlatformIcon } from "../icons";
import { platforms } from "../platforms";
import { Snippet } from "../components/snippet";

type ConnectedAccount = { id: string; platform: string; name: string; tokenExpiresAt?: string };
type ApiState = "checking" | "online" | "offline";

const steps = [
  {
    title: "Configure the environment",
    body: "Copy the example file and generate the 32-byte keys used for token encryption and API auth.",
    commands: ["cp .env.example .env", "openssl rand -hex 32   # ENCRYPTION_KEY", "openssl rand -hex 32   # ADMIN_TOKEN"],
  },
  {
    title: "Start Postgres and apply migrations",
    body: "The database stores accounts, encrypted OAuth tokens, and the scheduler queue.",
    commands: ["docker compose up -d postgres", "corepack pnpm install", "corepack pnpm db:migrate"],
  },
  {
    title: "Run the dashboard and API",
    body: "With MOCK_MODE=true everything works end to end without any platform credentials.",
    commands: ["corepack pnpm dev"],
  },
];

export default function Setup() {
  const [api, setApi] = useState<ApiState>("checking");
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [accountsError, setAccountsError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then((response) => setApi(response.ok ? "online" : "offline"))
      .catch(() => setApi("offline"));
    fetch(`${apiUrl}/accounts`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          // Outside mock mode every route needs the admin bearer token, which a browser cannot hold safely.
          setAccountsError(response.status === 401 ? "The API requires an admin token, so connection status is unavailable here." : "");
          return [];
        }
        return response.json();
      })
      .then((body: unknown) => setAccounts(Array.isArray(body) ? (body as ConnectedAccount[]) : []))
      .catch(() => setAccounts([]));
    return () => controller.abort();
  }, []);

  const connected = new Map(accounts.map((account) => [account.platform, account]));

  return (
    <main className="space-y-6">
      <section className="card bg-gradient-to-br from-brand/10 to-transparent">
        <h1 className="text-2xl font-bold tracking-tight">Setup</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Get the stack running, register each platform&apos;s OAuth app, then connect the accounts you publish from.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span
            className={`badge ${
              api === "online" ? "border-emerald-500/40 text-emerald-500" : api === "offline" ? "border-amber-500/40 text-amber-500" : ""
            }`}
          >
            {api === "online" ? <CheckIcon width={14} height={14} /> : <AlertIcon width={14} height={14} />}
            API {api === "checking" ? "checking…" : api}
          </span>
          <code className="font-mono text-xs text-ink-muted">{apiUrl}</code>
        </div>
        {api === "offline" ? (
          <p className="mt-3 text-sm text-ink-muted">
            Nothing is answering on that origin. Start it with <code className="font-mono">corepack pnpm dev</code>, or set{" "}
            <code className="font-mono">NEXT_PUBLIC_API_URL</code> if the API is hosted elsewhere. The published demo has no API behind it.
          </p>
        ) : null}
      </section>

      <section className="card space-y-5">
        <h2 className="text-lg font-semibold">1. Install and run</h2>
        <ol className="space-y-5">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/15 text-sm font-bold text-brand">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <h3 className="font-semibold">{step.title}</h3>
                <p className="text-sm text-ink-muted">{step.body}</p>
                {step.commands.map((command) => (
                  <Snippet key={command}>{command}</Snippet>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">2. Register OAuth apps</h2>
          <p className="text-sm text-ink-muted">
            Each platform needs its own developer app. Register this callback URL, then put the client id and secret in{" "}
            <code className="font-mono">.env</code>.
          </p>
        </div>
        <Snippet>{`${apiUrl}/api/oauth/<platform>/callback`}</Snippet>
        <p className="text-sm text-ink-muted">
          The redirect is signed with an HMAC <code className="font-mono">state</code> valid for ten minutes, and tokens are stored
          AES-256-GCM encrypted.
        </p>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">3. Connect accounts</h2>
          <p className="text-sm text-ink-muted">
            {accountsError || "Connect each platform you want to publish to. In mock mode publishing works without connecting anything."}
          </p>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {platforms.map((platform) => {
            const account = connected.get(platform.id);
            return (
              <li key={platform.id} className="card flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className="grid h-10 w-10 place-items-center rounded-xl"
                    style={{ backgroundColor: `${platform.accent}1f`, color: platform.accent }}
                  >
                    <PlatformIcon platform={platform.id} width={20} height={20} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold">{platform.label}</h3>
                    <p className="text-xs text-ink-muted">
                      {account ? `Connected as ${account.name}` : platform.unsupported ? "Publishing unsupported" : "Not connected"}
                    </p>
                  </div>
                  {account ? <CheckIcon width={18} height={18} className="ml-auto text-emerald-500" /> : null}
                </div>

                <p className="text-sm text-ink-muted">{platform.unsupported ?? platform.summary}</p>

                {platform.env.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {platform.env.map((name) => (
                      <li key={name} className="badge font-mono">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {platform.unsupported ? (
                    <span className="badge">No publishing API</span>
                  ) : (
                    <a className="btn-primary" href={`${apiUrl}/api/oauth/${platform.id}/start`}>
                      {account ? "Reconnect" : "Connect"}
                    </a>
                  )}
                  {platform.docs ? (
                    <a className="btn-ghost" href={platform.docs} target="_blank" rel="noreferrer noopener">
                      <LinkIcon width={14} height={14} /> Developer docs
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
