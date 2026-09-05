"use client";
import { useState } from "react";
import { CheckIcon, CopyIcon } from "../icons";

/** Copies a snippet to the clipboard, falling back to a manual-select hint. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" onClick={copy} className="btn-ghost px-2 py-1 text-xs" title={`Copy ${label ?? value}`}>
      {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
      <span className="sr-only">{copied ? "Copied" : `Copy ${label ?? value}`}</span>
    </button>
  );
}

/** A copyable code line used throughout the setup steps. */
export function Snippet({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface-muted px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{children}</code>
      <CopyButton value={children} />
    </div>
  );
}
