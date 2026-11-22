"use client";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { apiUrl } from "../config";
import { clearSession, sessionChanged, sessionToken, storeSession } from "../session";

export type SessionState =
  | { kind: "checking" }
  /** The API has no ADMIN_TOKEN (mock mode), so there is nothing to sign in to. */
  | { kind: "open" }
  /** The API did not answer. Pages report that themselves, and the static demo has no API at all. */
  | { kind: "unreachable" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; expiresAt?: string };

export type Session = { state: SessionState; signOut: () => Promise<void>; contentShown: boolean };

/** The longest delay `setTimeout` supports; a longer session is simply re-checked when it fires. */
const maxTimeout = 2_147_483_647;

/** Follows the API's view of the stored session, re-checking whenever it is stored, dropped or expires. */
export function useSession(): Session {
  const [state, setState] = useState<SessionState>({ kind: "checking" });
  // Once pages were shown, an ended session covers them instead of unmounting them, so unsaved edits survive signing in again.
  const [contentShown, setContentShown] = useState(false);

  const check = useCallback(async (signal: AbortSignal) => {
    const token = sessionToken();
    let answer: { required?: unknown; authenticated?: unknown; expiresAt?: unknown };
    try {
      const response = await fetch(`${apiUrl}/auth/session`, {
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      answer = (await response.json()) as typeof answer;
    } catch {
      if (!signal.aborted) { setState({ kind: "unreachable" }); setContentShown(true); }
      return;
    }
    if (signal.aborted) return;
    if (answer.required !== true) {
      setState({ kind: "open" }); setContentShown(true);
    } else if (answer.authenticated === true && token) {
      setState({ kind: "signed-in", expiresAt: typeof answer.expiresAt === "string" ? answer.expiresAt : undefined }); setContentShown(true);
    } else {
      clearSession({ notify: false });
      setState({ kind: "signed-out" });
    }
  }, []);

  useEffect(() => {
    let controller = new AbortController();
    void check(controller.signal);
    const recheck = () => {
      controller.abort();
      controller = new AbortController();
      void check(controller.signal);
    };
    window.addEventListener(sessionChanged, recheck);
    return () => {
      controller.abort();
      window.removeEventListener(sessionChanged, recheck);
    };
  }, [check]);

  // Shows the sign-in form when the session runs out, rather than at the next failing request.
  const expiresAt = state.kind === "signed-in" ? state.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.min(Math.max(Date.parse(expiresAt) - Date.now() + 1000, 0), maxTimeout);
    const timer = window.setTimeout(() => window.dispatchEvent(new Event(sessionChanged)), delay);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const signOut = useCallback(async () => {
    const token = sessionToken();
    setContentShown(false);
    // Revoke it on the API too, so a copy of the token stops working now rather than when it expires.
    if (token) await fetch(`${apiUrl}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    clearSession();
  }, []);

  return { state, signOut, contentShown };
}

/** Exchanges the admin token for a session; the admin token itself is never stored. */
function SignInForm({ ended }: { ended: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${apiUrl}/auth/session`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = (await response.json().catch(() => undefined)) as { token?: unknown; expiresAt?: unknown; error?: unknown } | undefined;
      if (response.ok && typeof body?.token === "string" && typeof body.expiresAt === "string") {
        storeSession({ token: body.token, expiresAt: body.expiresAt });
        return;
      }
      setError(
        response.status === 401
          ? "That admin token is not right."
          : response.status === 429
            ? "Too many sign-in attempts. Wait a minute and try again."
            : typeof body?.error === "string"
              ? body.error
              : `Sign-in failed (HTTP ${response.status}).`,
      );
    } catch {
      setError(`Could not reach the API at ${apiUrl}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card mx-auto w-full max-w-md space-y-4">
      <div>
        <h1 id="sign-in-title" className="text-xl font-bold tracking-tight">
          {ended ? "Sign in again" : "Sign in"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {ended
            ? "Your session ended. Sign in again to carry on — anything you had not saved is still here."
            : "This dashboard's API is protected. Enter the ADMIN_TOKEN configured on the API to start a session in this browser tab."}
        </p>
      </div>
      <label className="block text-sm font-medium">
        Admin token
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="current-password"
          required
          autoFocus
          className="field mt-1 font-mono"
        />
      </label>
      <div role="alert" className="text-sm text-rose-500">
        {error}
      </div>
      <button type="submit" className="btn-primary w-full" disabled={busy || !token.trim()}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-xs text-ink-muted">
        The token is exchanged for a short-lived session that ends when you close the tab or sign out; the token itself is not kept in the browser.
      </p>
    </form>
  );
}

/**
 * Renders the pages once the API either needs no sign-in or has a valid
 * session. When a session ends while pages are open, they stay mounted (and
 * inert) under the sign-in dialog so work in progress is not lost.
 */
export function SessionGate({ session, children }: { session: Session; children: ReactNode }) {
  const { state, contentShown } = session;
  if (state.kind === "checking") {
    return (
      <p className="card text-sm text-ink-muted" aria-busy="true">
        Connecting to the API…
      </p>
    );
  }
  if (state.kind === "signed-out" && !contentShown) return <SignInForm ended={false} />;
  const locked = state.kind === "signed-out";
  return (
    <>
      <div inert={locked}>{children}</div>
      {locked ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sign-in-title"
          className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
        >
          <SignInForm ended />
        </div>
      ) : null}
    </>
  );
}
