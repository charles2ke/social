/**
 * The dashboard's sign-in session: a short-lived token the API mints from
 * ADMIN_TOKEN (`POST /auth/session`). It is kept in sessionStorage — per tab,
 * gone when the tab closes — and sent as a bearer token, never as a cookie,
 * so another site cannot make the browser use it.
 */
const key = "social.session";

/** Dispatched on `window` whenever the session is stored or dropped. */
export const sessionChanged = "social:session";

type StoredSession = { token: string; expiresAt: string };

export function sessionToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const session = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as Partial<StoredSession> | null;
    if (typeof session?.token === "string" && typeof session.expiresAt === "string" && Date.parse(session.expiresAt) > Date.now()) return session.token;
  } catch {
    // Unreadable storage counts as signed out.
  }
  return undefined;
}

export function storeSession(session: StoredSession) {
  window.sessionStorage.setItem(key, JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));
  window.dispatchEvent(new Event(sessionChanged));
}

/** Drops the stored session; `notify: false` is for the sign-in gate itself, which already knows. */
export function clearSession({ notify = true }: { notify?: boolean } = {}) {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(key);
  if (notify) window.dispatchEvent(new Event(sessionChanged));
}
