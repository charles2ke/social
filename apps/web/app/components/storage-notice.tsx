"use client";
import { useEffect, useState } from "react";
import { apiUrl } from "../config";
import { AlertIcon } from "../icons";

/** Where the API keeps posts, as reported by `GET /ready`; "unknown" until it answers or when it is unreachable. */
export type StorageMode = "postgres" | "memory" | "down" | "unknown";

export function useStorageMode(): StorageMode {
  const [mode, setMode] = useState<StorageMode>("unknown");
  useEffect(() => {
    const controller = new AbortController();
    // /ready answers 503 with `database: "down"`, so the body is read whatever the status.
    fetch(`${apiUrl}/ready`, { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { database?: string }) =>
        setMode(body.database === "up" ? "postgres" : body.database === "memory" || body.database === "down" ? body.database : "unknown"),
      )
      .catch(() => {
        if (!controller.signal.aborted) setMode("unknown");
      });
    return () => controller.abort();
  }, []);
  return mode;
}

/** Warns when posts are not stored durably, which also means scheduled posts are never published. */
export function StorageNotice({ mode }: { mode: StorageMode }) {
  if (mode !== "memory" && mode !== "down") return null;
  const memory = mode === "memory";
  return (
    <p
      className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
        memory ? "border-amber-500/40 bg-amber-500/10" : "border-rose-500/40 bg-rose-500/10"
      }`}
    >
      <AlertIcon width={16} height={16} className={`mt-0.5 shrink-0 ${memory ? "text-amber-500" : "text-rose-500"}`} />
      {memory ? (
        <span>
          <strong className="font-semibold">Posts are only kept in memory.</strong> The API has no <code className="font-mono text-xs">DATABASE_URL</code>,
          so posts are lost when it restarts and scheduled posts are never published — the scheduler worker needs Postgres.
        </span>
      ) : (
        <span>
          <strong className="font-semibold">The database is unreachable.</strong> Saving, scheduling and publishing will fail until the API can reach
          Postgres again.
        </span>
      )}
    </p>
  );
}
