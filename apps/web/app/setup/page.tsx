"use client";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../config";
import { AlertIcon, CheckIcon, LinkIcon, PlatformIcon, XIcon } from "../icons";
import { platformMeta, platforms } from "../platforms";
import { ApiError, callApi, errorMessage } from "../posts";
import { Snippet } from "../components/snippet";

type ConnectedAccount = { id: string; platform: string; name: string; tokenExpiresAt?: string };
type ApiState = "checking" | "online" | "offline";
type Notice = { message: string; tone: "success" | "error" };

/**
 * The outcome the API's OAuth callback sends the browser back with
 * (`?connected=<platform>` or `?platform=<platform>&oauth_error=<message>`).
 */
function oauthOutcome(search: string): Notice | undefined {
  const query = new URLSearchParams(search);
  const connected = query.get("connected");
  if (connected) return { message: `${platformMeta(connected).label} is connected.`, tone: "success" };
  const failure = query.get("oauth_error");
  if (failure) {
    const platform = query.get("platform");
    return { message: `Connecting ${platform ? platformMeta(platform).label : "the account"} failed: ${failure.slice(0, 300)}`, tone: "error" };
  }
  return undefined;
}

const steps = [
  {
    title: "Configure the environment",
    body: "Copy the example file and generate the 32-byte keys: ENCRYPTION_KEY encrypts stored tokens, and ADMIN_TOKEN protects the API — it is also what you sign in to this dashboard with.",
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
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [pending, setPending] = useState<{ platform: string; action: "connect" | "disconnect" } | undefined>(undefined);

  const loadAccounts = useCallback(async (signal?: AbortSignal) => {
    try {
      setAccounts(await callApi<ConnectedAccount[]>("/accounts", { signal }));
      setAccountsError("");
    } catch (error) {
      if (signal?.aborted || (error instanceof ApiError && error.status === 401)) return;
      setAccounts([]);
      setAccountsError(error instanceof ApiError ? `The API answered "${error.message}", so connection status is unavailable.` : "");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then((response) => setApi(response.ok ? "online" : "offline"))
      .catch(() => setApi("offline"));
    void loadAccounts(controller.signal);
    return () => controller.abort();
  }, [loadAccounts]);

  // Back from connecting an account: report how it went, then drop the query so a reload does not repeat it.
  useEffect(() => {
    const outcome = oauthOutcome(window.location.search);
    if (!outcome) return;
    setNotice(outcome);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  /** OAuth starts with a navigation, which cannot carry the session header, so the API hands over the authorization URL instead. */
  const connect = async (platform: string) => {
    setPending({ platform, action: "connect" });
    setNotice(undefined);
    try {
      const returnTo = new URL(window.location.pathname, window.location.origin).href;
      const { url } = await callApi<{ url: string }>(`/api/oauth/${encodeURIComponent(platform)}/start?returnTo=${encodeURIComponent(returnTo)}`);
      // Mock mode answers with a callback path on the API itself.
      const target = new URL(url, apiUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("unexpected authorization URL");
      window.location.assign(target.href);
    } catch (error) {
      setNotice({ message: error instanceof ApiError ? error.message : `Could not start connecting ${platformMeta(platform).label}: ${errorMessage(error)}`, tone: "error" });
      setPending(undefined);
    }
  };

  const disconnect = async (account: ConnectedAccount) => {
    const label = platformMeta(account.platform).label;
    if (!window.confirm(`Disconnect ${label} (${account.name})? Its stored tokens are deleted here; revoke the app's access in ${label}'s settings too.`)) return;
    setPending({ platform: account.platform, action: "disconnect" });
    setNotice(undefined);
    try {
      await callApi(`/accounts/${encodeURIComponent(account.id)}/disconnect`, { method: "POST" });
      setNotice({ message: `${label} is disconnected.`, tone: "success" });
    } catch (error) {
      setNotice({ message: errorMessage(error), tone: "error" });
    } finally {
      setPending(undefined);
      void loadAccounts();
    }
  };

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
          Set <code className="font-mono">OAUTH_REDIRECT_BASE_URL</code> to the API&apos;s public URL and{" "}
          <code className="font-mono">BASE_URL</code> to this dashboard&apos;s, which is where the API sends you back after connecting. The
          redirect carries a signed, single-use <code className="font-mono">state</code> valid for ten minutes, and tokens are stored
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
        <div role="status" aria-live="polite">
          {notice ? (
            <p className={`card py-3 text-sm break-words ${notice.tone === "error" ? "border-rose-500/40 text-rose-500" : "border-emerald-500/40 text-emerald-600"}`}>
              {notice.message}
            </p>
          ) : null}
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
                    <>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={Boolean(pending)}
                        aria-label={`${account ? "Reconnect" : "Connect"} ${platform.label}`}
                        onClick={() => void connect(platform.id)}
                      >
                        {pending?.platform === platform.id && pending.action === "connect" ? "Redirecting…" : account ? "Reconnect" : "Connect"}
                      </button>
                      {account ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={Boolean(pending)}
                          aria-label={`Disconnect ${platform.label}`}
                          onClick={() => void disconnect(account)}
                        >
                          <XIcon width={14} height={14} /> {pending?.platform === platform.id && pending.action === "disconnect" ? "Disconnecting…" : "Disconnect"}
                        </button>
                      ) : null}
                    </>
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
