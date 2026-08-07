import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

/**
 * Fixed-window request counters, in memory.
 *
 * Deliberately not a token bucket and not persisted: the one thing this
 * guards is guessing a device-pairing code, and a code lives five
 * minutes. A counter that resets on restart is not a weakness there —
 * the secret it protects has already expired by the time any restart
 * window matters.
 *
 * In-memory also means per-process. Marginalia deploys as a single
 * container per environment, so that is the whole fleet today; if it
 * ever runs replicated, the per-IP limit dilutes by the replica count
 * and the global limit becomes per-replica. Say so out loud rather than
 * letting a future deploy quietly weaken it.
 */

export interface RateLimitRule {
  /** Attempts permitted per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets. Fed to the `Retry-After` header. */
  retryAfterSec: number;
}

/** Sweep expired entries once the map passes this many keys. */
const SWEEP_THRESHOLD = 4096;

export class FixedWindowRateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly rule: RateLimitRule) {}

  /**
   * Would the next attempt be allowed? Read-only — callers record a hit
   * separately, so a *successful* request need not spend budget. That
   * split is the point: legitimate pairing succeeds first try, so only
   * guessing consumes the allowance.
   */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.counts.get(key);
    if (!entry || entry.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
    if (entry.count < this.rule.limit) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  /** Count one attempt against `key`. */
  record(key: string, now: number = Date.now()): void {
    const entry = this.counts.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.counts.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.counts.set(key, { count: 1, resetAt: now + this.rule.windowMs });
      return;
    }
    entry.count += 1;
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.counts.clear();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.counts) {
      if (entry.resetAt <= now) this.counts.delete(key);
    }
  }
}

/**
 * Best-effort client identity for rate limiting.
 *
 * `trustProxy` must be on when Marginalia sits behind a reverse proxy
 * (the Docker deploy binds to 127.0.0.1 behind Caddy, so it does) —
 * otherwise every request arrives from the proxy and the whole internet
 * shares one bucket. It is off by default because believing
 * `X-Forwarded-For` from a directly-exposed port lets any caller mint a
 * fresh identity per request and skip the limit entirely.
 *
 * The *rightmost* entry is the one our own proxy appended, so a client
 * that sends a forged `X-Forwarded-For` only pollutes the entries to its
 * left. Reading the leftmost — the usual "original client" convention —
 * is exactly the spoofable choice here.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (trustProxy) {
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
      const nearest = hops[hops.length - 1];
      if (nearest) return nearest;
    }
  }
  try {
    // Throws when no Bun server is bound to the context — which is the
    // case for direct `app.hono.fetch(...)` calls in tests.
    const address = getConnInfo(c).remote.address;
    if (address) {
      if (!trustProxy && forwarded) warnAboutUntrustedProxy(address);
      return address;
    }
  } catch {
    /* fall through to the shared bucket */
  }
  // No usable address: everyone lands in one bucket. Fails closed
  // (shared budget, still limited) rather than open.
  return 'unknown';
}

let warnedAboutProxy = false;

/** Test seam: re-arm the once-per-process warning. */
export function resetProxyWarning(): void {
  warnedAboutProxy = false;
}

/**
 * Say something when the deployment is almost certainly misconfigured:
 * a proxy in front is setting `X-Forwarded-For`, and we are throwing it
 * away, so every visitor shares one bucket. Silent otherwise, because
 * that combination has no legitimate reading.
 *
 * Gated on the peer being loopback/private so the local dev proxy can't
 * trip it — Vite's `/api` proxy doesn't set `X-Forwarded-For` at all
 * (`xfwd` is off by default), but a future dev setup that did shouldn't
 * start printing deployment advice.
 *
 * Once per process: this fires on a hot path, and an operator who
 * ignored it the first time is not helped by the ten-thousandth.
 */
function warnAboutUntrustedProxy(peer: string): void {
  if (warnedAboutProxy || !isPrivateAddress(peer)) return;
  warnedAboutProxy = true;
  console.warn(
    `[marginalia] requests are arriving from ${peer} with an X-Forwarded-For header, but MARGINALIA_TRUST_PROXY is not set. ` +
      'Per-client rate limits are keying on the proxy, so every visitor shares one budget. ' +
      'Set MARGINALIA_TRUST_PROXY=1 if a reverse proxy you control fronts this server.',
  );
}

/** Loopback or RFC1918/RFC4193 — i.e. plausibly our own proxy. */
export function isPrivateAddress(address: string): boolean {
  const addr = address.toLowerCase().replace(/^::ffff:/, '');
  if (addr === '::1' || addr.startsWith('fc') || addr.startsWith('fd')) return true;
  const octets = addr.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}
