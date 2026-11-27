import { type PlatformId, type TextConstraints, TextValidationError } from "./types.js";

/**
 * Characters as platforms count them: UTF-16 code units, the same as
 * `String.length`, so the dashboard's live counter and the API agree.
 */
export const textLength = (text: string) => text.length;

/** Title-first platforms (YouTube, Strava) publish the first line as the title and the rest as the description. */
export function splitTitle(text: string): { title: string; body: string } {
  const [title = "", ...rest] = text.split("\n");
  return { title, body: rest.join("\n") };
}

/** Every limit `text` exceeds on a platform, as user-facing messages; empty when it fits. */
export function textProblems(platform: PlatformId, constraints: TextConstraints | undefined, text: string): string[] {
  if (!constraints) return [];
  const problems: string[] = [];
  const { titleMaxLength, maxLength } = constraints;
  if (titleMaxLength !== undefined) {
    const { title, body } = splitTitle(text);
    if (textLength(title) > titleMaxLength) problems.push(`${platform} titles (the first line) are limited to ${titleMaxLength} characters, this one has ${textLength(title)}`);
    if (maxLength !== undefined && textLength(body) > maxLength) problems.push(`${platform} descriptions (after the first line) are limited to ${maxLength} characters, this one has ${textLength(body)}`);
  } else if (maxLength !== undefined && textLength(text) > maxLength) {
    problems.push(`${platform} posts are limited to ${maxLength} characters, this one has ${textLength(text)}`);
  }
  return problems;
}

/** Rejects text a platform would refuse or cut short, instead of publishing a silently truncated post. */
export function validateText(platform: PlatformId, constraints: TextConstraints | undefined, text: string): void {
  const [problem] = textProblems(platform, constraints, text);
  if (problem) throw new TextValidationError(problem, platform);
}
