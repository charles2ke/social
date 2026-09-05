"use client";
import { useEffect, useState } from "react";
import { MoonIcon, SunIcon, SystemIcon } from "../icons";
import { themeStorageKey } from "./theme-script";

export type Theme = "light" | "dark" | "system";

const themes: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: SystemIcon },
];

const storageKey = themeStorageKey;

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** Applies the theme by toggling the `dark` class the Tailwind config keys off. */
function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    const initial = isTheme(stored) ? stored : "system";
    setTheme(initial);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    apply(theme);
    localStorage.setItem(storageKey, theme);
    if (theme !== "system") return;
    // Follow the OS while "system" is selected, without a reload.
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => apply("system");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [theme, ready]);

  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-edge bg-surface p-1" role="group" aria-label="Color theme">
      {themes.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-pressed={theme === value}
          title={`${label} theme`}
          className={`rounded-lg p-2 transition-colors ${
            theme === value ? "bg-brand text-brand-ink" : "text-ink-muted hover:bg-surface-muted hover:text-ink"
          }`}
        >
          <Icon width={16} height={16} />
          <span className="sr-only">{label} theme</span>
        </button>
      ))}
    </div>
  );
}
