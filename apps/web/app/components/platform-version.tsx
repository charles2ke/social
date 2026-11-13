import { AlertIcon, CheckIcon, PencilIcon, PlatformIcon } from "../icons";
import type { MediaAttachment } from "../media";
import { platformMeta } from "../platforms";
import type { PlatformOverride } from "../posts";
import { limitChips, type LimitChip, type TextLimit } from "../text";

/** A short name for an attachment: the last segment of its URL. */
function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

export function LimitChips({ chips, label }: { chips: LimitChip[]; label: string }) {
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {chips.map((chip) => (
        <li key={chip.key} className={`badge ${chip.invalid ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : ""}`}>
          {chip.invalid ? <AlertIcon width={12} height={12} /> : null}
          {chip.label}
        </li>
      ))}
    </ul>
  );
}

type Props = {
  platform: string;
  /** Set once the platform is customized. */
  override: PlatformOverride | undefined;
  /** The post's own text and attachments, which the platform uses for anything it does not override. */
  text: string;
  media: MediaAttachment[];
  limits: TextLimit[];
  /** What would make publishing to this platform fail; undefined until the API has checked the draft. */
  problems: string[] | undefined;
  disabled: boolean;
  onCustomize(): void;
  onReset(): void;
  onTextChange(value: string): void;
  onToggleMedia(url: string): void;
};

/** One platform's version of the post: its problems and, once customized, its own text and choice of attachments. */
export function PlatformVersion({ platform, override, text, media, limits, problems, disabled, onCustomize, onReset, onTextChange, onToggleMedia }: Props) {
  const meta = platformMeta(platform);
  const ownText = override?.text ?? text;
  // Attachments only this platform uses (e.g. set through the API) stay listed, so saving keeps them.
  const options = [...media, ...(override?.media ?? []).filter((item) => !media.some((main) => main.url === item.url))];
  const chosen = new Set((override?.media ?? media).map((item) => item.url));
  return (
    <li aria-label={`${meta.label} version`} className="space-y-3 rounded-xl border border-edge p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}>
          <PlatformIcon platform={platform} width={16} height={16} />
        </span>
        <span className="text-sm font-medium">{meta.label}</span>
        {override ? <span className="badge">Customized</span> : null}
        {problems === undefined ? null : problems.length ? (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertIcon width={14} height={14} /> {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckIcon width={14} height={14} /> Within limits
          </span>
        )}
        <button type="button" onClick={override ? onReset : onCustomize} className="btn-ghost ml-auto px-3 py-1.5 text-xs" disabled={disabled}>
          {override ? (
            <>
              Use main post<span className="sr-only"> on {meta.label}</span>
            </>
          ) : (
            <>
              <PencilIcon width={14} height={14} /> Customize<span className="sr-only"> {meta.label}</span>
            </>
          )}
        </button>
      </div>
      {override ? (
        <div className="space-y-2">
          <textarea
            aria-label={`${meta.label} text`}
            value={ownText}
            onChange={(event) => onTextChange(event.target.value)}
            className="field min-h-24 resize-y leading-relaxed"
          />
          {override.text === undefined ? <p className="text-xs text-ink-muted">Matches the main post until you edit it.</p> : null}
          <LimitChips chips={limitChips(limits, ownText)} label={`${meta.label} limits`} />
          {options.length ? (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">Attachments to publish here</legend>
              {options.map((item) => (
                <label key={item.url} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={chosen.has(item.url)} onChange={() => onToggleMedia(item.url)} className="h-4 w-4 accent-brand" />
                  <span className="break-all">{fileName(item.url)}</span>
                  <span className="badge">{item.kind}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </div>
      ) : null}
      {problems?.length ? (
        <ul className="space-y-1.5">
          {problems.map((problem) => (
            <li key={problem} className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <AlertIcon width={14} height={14} className="mt-0.5 shrink-0 text-amber-500" />
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
