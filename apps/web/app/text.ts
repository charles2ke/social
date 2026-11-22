/** Mirrors `TextConstraints` in @social/core; limits come from the API's `GET /platforms`. */
export type TextConstraints = { maxLength?: number; titleMaxLength?: number };
export type TextUsage = { part: "post" | "title" | "description"; used: number; limit: number };

/**
 * How much of each limit a text uses on a platform — the browser mirror of
 * `textProblems` in packages/core/src/text.ts (characters are UTF-16 code
 * units, and title-first platforms take the first line as the title). The API
 * enforces the same limits when publishing.
 */
export function textUsage(constraints: TextConstraints | undefined, text: string): TextUsage[] {
  if (!constraints) return [];
  const { maxLength, titleMaxLength } = constraints;
  if (titleMaxLength === undefined) return maxLength === undefined ? [] : [{ part: "post", used: text.length, limit: maxLength }];
  const [title = "", ...rest] = text.split("\n");
  const body = rest.join("\n");
  return [
    { part: "title", used: title.length, limit: titleMaxLength },
    ...(maxLength === undefined ? [] : [{ part: "description" as const, used: body.length, limit: maxLength }]),
  ];
}

export const isOverLimit = (usage: TextUsage[]) => usage.some(({ used, limit }) => used > limit);
