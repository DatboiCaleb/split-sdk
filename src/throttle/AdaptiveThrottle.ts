/**
 * AdaptiveThrottle — a token-bucket request scheduler sized from observed
 * `X-RateLimit-*` response headers (see {@link RateLimitParser}), so the SDK
 * stays under the server's actual rate-limit window instead of guessing a
 * fixed request rate. On a 429 response the bucket enters a penalized state
 * (refill rate halved) for a configurable cooldown before resuming normal
 * throughput.
 */

import { parseRateLimitHeaders, type RateLimitInfo } from "./RateLimitParser.js";

export const DEFAULT_PENALTY_DURATION_MS = 5_000;

export interface AdaptiveThrottleConfig {
  /** How long a 429 halves the refill rate for. Default: 5 000ms. */
  penaltyDurationMs?: number;
  /** Time source — exposed for deterministic tests. */
  now?: () => number;
}

/** Snapshot of the throttle's internal state, for monitoring. */
export interface ThrottleStats {
  tokenCount: number;
  /** Tokens per millisecond, accounting for any active penalty. */
  refillRate: number;
  penalized: boolean;
  pendingQueueDepth: number;
}

/**
 * Token-bucket scheduler. Call {@link update} with parsed rate-limit headers
 * after every response, {@link recordRateLimited} on a 429, and {@link
 * acquire} before dispatching each outbound request.
 */
export class AdaptiveThrottle {
  private _limit = Infinity;
  private _tokens = Infinity;
  private _baseRefillRate = Infinity; // tokens per ms, derived from the last rate-limit headers
  private _penalized = false;
  private _penaltyTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastRefillAt: number;
  private _queue: Array<() => void> = [];
  private _drainTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _now: () => number;
  private readonly _penaltyDurationMs: number;

  constructor(config: AdaptiveThrottleConfig = {}) {
    this._now = config.now ?? (() => Date.now());
    this._penaltyDurationMs = config.penaltyDurationMs ?? DEFAULT_PENALTY_DURATION_MS;
    this._lastRefillAt = this._now();
  }

  private get _effectiveRefillRate(): number {
    return this._penalized ? this._baseRefillRate / 2 : this._baseRefillRate;
  }

  /** Resize the bucket from the server's most recently observed rate-limit headers. */
  update(info: RateLimitInfo): void {
    const now = this._now();
    this._refill(now);

    if (!Number.isFinite(info.limit)) {
      this._limit = Infinity;
      this._tokens = Infinity;
      this._baseRefillRate = Infinity;
      return;
    }

    this._limit = info.limit;
    this._tokens = Math.min(info.remaining, this._limit);

    const windowMs = Math.max(1, info.resetAt - now);
    this._baseRefillRate = this._limit / windowMs;
  }

  /** Same as {@link update}, but parses the headers first. */
  updateFromHeaders(headers: Parameters<typeof parseRateLimitHeaders>[0]): void {
    this.update(parseRateLimitHeaders(headers));
  }

  /** Record a 429 response: halves the refill rate for `penaltyDurationMs`. */
  recordRateLimited(): void {
    const now = this._now();
    this._refill(now);
    this._penalized = true;

    if (this._penaltyTimer !== null) clearTimeout(this._penaltyTimer);
    this._penaltyTimer = setTimeout(() => {
      this._penaltyTimer = null;
      this._penalized = false;
      if (this._queue.length > 0) this._scheduleDrain();
    }, this._penaltyDurationMs);
  }

  /** Resolve once a token is available, consuming it. */
  acquire(): Promise<void> {
    const now = this._now();
    this._refill(now);

    if (!this._penalized && this._tokens >= 1) {
      this._tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
      this._scheduleDrain();
    });
  }

  /** Snapshot current bucket state for monitoring. */
  getStats(): ThrottleStats {
    return {
      tokenCount: this._tokens,
      refillRate: this._effectiveRefillRate,
      penalized: this._penalized,
      pendingQueueDepth: this._queue.length,
    };
  }

  /** Wrap a `fetch`-compatible function so every call acquires a token and updates from response headers. */
  wrapFetch(fetchFn: typeof fetch): typeof fetch {
    const throttle = this;
    return async function throttledFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      await throttle.acquire();
      const response = await fetchFn(input, init);
      throttle.updateFromHeaders(response.headers);
      if (response.status === 429) {
        throttle.recordRateLimited();
      }
      return response;
    } as typeof fetch;
  }

  private _refill(now: number): void {
    const rate = this._effectiveRefillRate;
    if (Number.isFinite(rate)) {
      const elapsed = Math.max(0, now - this._lastRefillAt);
      this._tokens = Math.min(this._limit, this._tokens + elapsed * rate);
    }
    this._lastRefillAt = now;
  }

  private _scheduleDrain(): void {
    if (this._drainTimer !== null) return;
    if (this._penalized) {
      // recordRateLimited()'s recovery timer re-triggers draining once the penalty lifts.
      return;
    }

    const rate = this._effectiveRefillRate;
    const delay =
      Number.isFinite(rate) && rate > 0 ? Math.max(0, (1 - this._tokens) / rate) : 50;

    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this._drainQueue();
    }, delay);
  }

  private _drainQueue(): void {
    if (this._penalized) return;
    const now = this._now();
    this._refill(now);
    while (this._tokens >= 1 && this._queue.length > 0) {
      this._tokens -= 1;
      const next = this._queue.shift();
      next?.();
    }
    if (this._queue.length > 0) {
      this._scheduleDrain();
    }
  }
}
