/**
 * A request pacer for rate-limited hosted endpoints.
 *
 * This exists for a specific, common case: free and evaluation tiers of hosted
 * model APIs cap you at a fixed requests-per-minute. NVIDIA's build.nvidia.com
 * free tier is 40 RPM. Recursive's base-memory enrichment runs at concurrency 6
 * over hundreds of files, so without pacing it fires far faster than 40 RPM and
 * the endpoint starts returning 429 partway through indexing a repo, which
 * leaves the memory half-built and the run looking like a failure.
 *
 * The strategy is deliberately the simple one: even spacing rather than a
 * bursty token bucket. At 40 RPM every request start is spaced 1500ms after the
 * previous one. This guarantees at most `rpm` starts in any rolling minute, and
 * it is smoother on the endpoint than letting 40 requests burst at second zero
 * and then stalling. Requests still overlap in flight, so concurrency still
 * hides latency; it is only the *starts* that are spaced.
 *
 * `rpm <= 0` disables pacing entirely, which is the right default for Anthropic,
 * OpenAI proper, and self-hosted models where you set your own limits.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  /** Absolute time the next request is allowed to start. */
  private next = 0;

  constructor(rpm: number) {
    // Guard against a caller passing something absurd; 0 means "no limit".
    this.intervalMs = rpm > 0 ? 60_000 / rpm : 0;
  }

  /**
   * Resolve when it is this caller's turn to fire.
   *
   * Reserves the slot synchronously (updates `next` before awaiting) so that
   * concurrent callers each get a distinct, correctly-spaced slot rather than
   * all reading the same `next` and bunching up.
   */
  async acquire(): Promise<void> {
    if (this.intervalMs === 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    const wait = at - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Retry a request that failed a retryable way (429 or 5xx), honouring a
 * server-provided Retry-After when present and backing off exponentially
 * otherwise.
 *
 * The distinction matters: a 429 is "you asked too fast, here is when to come
 * back", and the server often tells you exactly how long via Retry-After. A 5xx
 * is "something broke, maybe transiently". Both are worth retrying; a 400 or 401
 * is not, and is rethrown immediately so a bad key fails loudly instead of being
 * silently retried four times.
 */
export interface RetryableError extends Error {
  status?: number;
  /** Seconds the server asked us to wait, parsed from Retry-After. */
  retryAfterSeconds?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; onRetry?: (attempt: number, waitMs: number, status?: number) => void } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error as RetryableError;
      const status = err.status;
      const retryable = status === 429 || (status !== undefined && status >= 500 && status < 600);

      if (!retryable || attempt >= maxRetries) throw error;

      // Prefer the server's own instruction. Fall back to exponential backoff
      // with jitter (1s, 2s, 4s, 8s ...) so a fleet of workers that all got
      // 429'd at once do not synchronously retry and 429 again together.
      const backoffMs =
        err.retryAfterSeconds !== undefined
          ? err.retryAfterSeconds * 1000
          : Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random());

      options.onRetry?.(attempt + 1, backoffMs, status);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/** Parse a Retry-After header, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}
