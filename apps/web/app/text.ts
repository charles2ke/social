/** Mirrors `TextLimit` in `@social/core`; `GET /platforms` reports each platform's limits. */
export type TextLimit = {
  field: string;
  part: "text" | "firstLine" | "rest";
  max: number;
  unit: "characters" | "utf16" | "bytes";
  disallowed?: string[];
};

const encoder = new TextEncoder();

/** Mirror of `@social/core`'s counting so the composer's counters update as you type; the API stays authoritative. */
export function countText(text: string, unit: TextLimit["unit"]): number {
  if (unit === "utf16") return text.length;
  if (unit === "bytes") return encoder.encode(text).length;
  return Array.from(text).length;
}

/** The part of the post text a platform field receives, split on the first line break. */
export function textPart(text: string, part: TextLimit["part"]): string {
  if (part === "text") return text;
  const newline = text.indexOf("\n");
  if (part === "firstLine") return newline === -1 ? text : text.slice(0, newline);
  return newline === -1 ? "" : text.slice(newline + 1);
}

export type LimitChip = { key: string; label: string; invalid: boolean };

/**
 * One chip per limit, e.g. "Instagram caption 72/2200" or "YouTube description
 * 30/5000 bytes", flagged once the text breaks it.
 */
export function limitChips(limits: readonly TextLimit[], text: string, prefix = ""): LimitChip[] {
  return limits.map((limit) => {
    const value = textPart(text, limit.part);
    const used = countText(value, limit.unit);
    const unit = limit.unit === "bytes" ? " bytes" : "";
    const disallowed = (limit.disallowed ?? []).some((character) => value.includes(character));
    return { key: `${prefix}${limit.field}`, label: `${prefix}${limit.field} ${used}/${limit.max}${unit}`, invalid: used > limit.max || disallowed };
  });
}
