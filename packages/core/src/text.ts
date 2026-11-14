import { type PlatformId, type TextLimit, type TextPart, type TextUnit, TextValidationError } from "./types.js";

const encoder = new TextEncoder();

/** Measures text the way a platform counts it — an emoji is 1 character, 2 UTF-16 code units and 4 bytes. */
export function countText(text: string, unit: TextUnit): number {
  if (unit === "utf16") return text.length;
  if (unit === "bytes") return encoder.encode(text).length;
  return Array.from(text).length;
}

/** The part of the post text a platform field receives, split on the first "\n" as the adapters do. */
export function textPart(text: string, part: TextPart): string {
  if (part === "text") return text;
  const newline = text.indexOf("\n");
  if (part === "firstLine") return newline === -1 ? text : text.slice(0, newline);
  return newline === -1 ? "" : text.slice(newline + 1);
}

export type TextUsage = TextLimit & { used: number };

/** How much of each limit `text` uses. */
export function measureText(limits: readonly TextLimit[], text: string): TextUsage[] {
  return limits.map((limit) => ({ ...limit, used: countText(textPart(text, limit.part), limit.unit) }));
}

const unitNames: Record<TextUnit, string> = { characters: "characters", utf16: "UTF-16 code units", bytes: "bytes" };
const partHints: Record<TextPart, string> = { text: "", firstLine: " (the first line)", rest: " (everything after the first line)" };

/** Every way `text` breaks a platform's limits; empty when it fits. */
export function textProblems(platform: PlatformId, limits: readonly TextLimit[], text: string): string[] {
  return measureText(limits, text).flatMap((usage) => {
    const where = `the ${usage.field}${partHints[usage.part]}`;
    const problems: string[] = [];
    if (usage.used > usage.max) {
      problems.push(`${platform} allows at most ${usage.max} ${unitNames[usage.unit]} in ${where}, received ${usage.used}`);
    }
    const value = textPart(text, usage.part);
    const found = (usage.disallowed ?? []).filter((character) => value.includes(character));
    if (found.length) problems.push(`${platform} does not allow ${found.map((character) => `"${character}"`).join(" or ")} in ${where}`);
    return problems;
  });
}

/** Throws a `TextValidationError` for the first limit `text` breaks. */
export function validateText(platform: PlatformId, limits: readonly TextLimit[], text: string) {
  const [problem] = textProblems(platform, limits, text);
  if (problem) throw new TextValidationError(problem, platform);
}
