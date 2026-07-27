/**
 * RateLimitParser — reads `X-RateLimit-*` headers from Soroban RPC / Horizon
 * responses so {@link AdaptiveThrottle} can size its token bucket to match
 * what the server actually observed.
 *
 * `X-RateLimit-Reset` is treated as a Unix timestamp in seconds (the
 * convention used by Horizon/Soroban RPC and most REST rate-limit headers),
 * and is returned as milliseconds since epoch to match `Date.now()`.
 */

/** A source of response headers — either a real `Headers` or a plain object. */
export type HeadersLike = Headers | Record<string, string>;

/** Parsed `X-RateLimit-*` header values. */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  /** Milliseconds since epoch at which the rate-limit window resets. */
  resetAt: number;
}

function getHeader(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key !== undefined ? record[key]! : null;
}

function parseNumberHeader(headers: HeadersLike, name: string): number | undefined {
  const raw = getHeader(headers, name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
 * from `headers`. Any missing header defaults its field to `Infinity`
 * (`limit`/`remaining`) or `0` (`resetAt`) so an unthrottled/unknown server
 * never blocks requests.
 */
export function parseRateLimitHeaders(headers: HeadersLike): RateLimitInfo {
  const limit = parseNumberHeader(headers, "X-RateLimit-Limit");
  const remaining = parseNumberHeader(headers, "X-RateLimit-Remaining");
  const resetSeconds = parseNumberHeader(headers, "X-RateLimit-Reset");

  return {
    limit: limit ?? Infinity,
    remaining: remaining ?? Infinity,
    resetAt: resetSeconds !== undefined ? resetSeconds * 1000 : 0,
  };
}
