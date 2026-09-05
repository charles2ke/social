"use client";
import Link from "next/link";
import { useSelectedLayoutSegments } from "next/navigation";
import { useState } from "react";
import { HomeIcon, MenuIcon, SetupIcon } from "../icons";
import { ThemeToggle } from "./theme";

const links = [
  { href: "/", segment: null, label: "Composer", description: "Write and publish", Icon: HomeIcon },
  { href: "/setup", segment: "setup", label: "Setup", description: "Connect platforms", Icon: SetupIcon },
];

/** Sticky top bar plus a sidebar that collapses into a disclosure on small screens. */
export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const segments = useSelectedLayoutSegments();
  const [open, setOpen] = useState(false);
  const current = segments[0] ?? null;

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Primary">
      {links.map(({ href, segment, label, description, Icon }) => {
        const active = current === segment;
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={`flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
              active ? "bg-brand/10 text-ink ring-1 ring-brand/40" : "text-ink-muted hover:bg-surface-muted hover:text-ink"
            }`}
          >
            <Icon width={18} height={18} className="mt-0.5 shrink-0" />
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-ink-muted">{description}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-edge bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <button
            type="button"
            className="btn-ghost px-2 py-2 md:hidden"
            aria-expanded={open}
            aria-controls="primary-nav"
            onClick={() => setOpen((value) => !value)}
          >
            <MenuIcon width={18} height={18} />
            <span className="sr-only">Toggle navigation</span>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand text-sm font-black text-brand-ink">S</span>
            <span className="text-base font-semibold tracking-tight">Social</span>
          </Link>
          <span className="badge hidden sm:inline-flex">Self-hosted</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-8">
        <aside className="hidden w-60 shrink-0 md:block">
          <div className="sticky top-24">{nav}</div>
        </aside>
        <div className="min-w-0 flex-1">
          <div id="primary-nav" className={`mb-6 card p-3 md:hidden ${open ? "" : "hidden"}`}>
            {nav}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
