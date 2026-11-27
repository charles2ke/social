/**
 * Environment helpers that treat a blank value (`KEY=` in `.env`, or an empty
 * variable in compose) as unset, and fail fast on a malformed number instead
 * of quietly turning a limit into NaN.
 */
export type Env = Record<string, string | undefined>;

export function stringEnv(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

export function numberEnv(env: Env, name: string, fallback: number, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  const raw = stringEnv(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = options;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}
