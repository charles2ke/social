/**
 * Small fixed-window limiter for the unauthenticated OAuth callback, which
 * would otherwise let a caller brute-force `state` values or drive token
 * exchanges against a platform. Keeps state in-process; put a shared limiter
 * in front of the API when running more than one instance.
 */
export type RateLimiter = (key: string, now?: number) => boolean;

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key, now = Date.now()) => {
    for (const [existing, window] of hits) if (window.resetAt <= now) hits.delete(existing);
    const window = hits.get(key);
    if (!window || window.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  };
}
