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
 * How many reverse-proxy hops in front of us are ours, and therefore how
 * far from the right of `X-Forwarded-For` the real client sits.
 *
 * A count rather than a boolean so a chained topology can be expressed:
 * with Cloudflare in front of Caddy the header reads `client, cf-edge`
 * once Caddy appends, and reading only the rightmost would bucket every
 * visitor under the same edge address. This mirrors `TRUSTED_PROXY_HOPS`
 * in noctua-mail so the two services on the same host describe the same
 * topology the same way.
 *
 * Unset means 0 — no proxy assumed. That deliberately differs from
 * noctua-mail's default of 1: this image is also run bare (see the
 * README's `docker run -p 3434:3434`), where believing the header would
 * make the limit decorative. The bundled deploy script derives the right
 * value from its binding and passes it explicitly, so the default is
 * what protects the *un*bundled case rather than the normal one.
 *
 * Garbage fails closed to 0.
 */
export function parseTrustedProxyHops(raw: string | undefined | null): number {
  if (raw == null) return 0;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized === 'false' || normalized === 'no') return 0;
  if (normalized === 'true' || normalized === 'yes') return 1;
  // Digits only. `parseInt` would take "1.5" as 1 and "2abc" as 2, which
  // would quietly turn a typo into a trusted topology.
  if (!/^\d+$/.test(normalized)) return 0;
  const hops = Number.parseInt(normalized, 10);
  return Number.isFinite(hops) && hops > 0 ? hops : 0;
}

/**
 * Best-effort client identity for rate limiting.
 *
 * Counting from the *right* is the whole trick: each proxy appends the
 * peer it actually saw, so the Nth-from-last entry is the one our own
 * Nth proxy vouched for. A client that forges a header only pollutes the
 * entries to its left. Reading the leftmost — the usual "original
 * client" convention — is precisely the spoofable choice.
 *
 * Everything else falls back to the socket peer, which cannot be forged
 * at all: no header, a chain shorter than the configured topology
 * (so we can't tell a real hop from a spoof), or no trusted hops. Behind
 * a proxy that resolves to the proxy — one shared bucket, which is the
 * safe direction — and with no proxy it is the real client.
 */
export function clientKey(c: Context, trustedHops: number): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (trustedHops > 0 && forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length >= trustedHops) {
      const vouched = hops[hops.length - trustedHops];
      if (vouched) return vouched;
    } else {
      warnAboutShortChain(hops.length, trustedHops);
    }
  }
  try {
    // Throws when no Bun server is bound to the context — which is the
    // case for direct `app.hono.fetch(...)` calls in tests.
    const address = getConnInfo(c).remote.address;
    if (address) {
      if (trustedHops === 0 && forwarded) warnAboutUntrustedProxy(address);
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
let warnedAboutChain = false;

/** Test seam: re-arm the once-per-process warnings. */
export function resetProxyWarning(): void {
  warnedAboutProxy = false;
  warnedAboutChain = false;
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
    `[marginalia] requests are arriving from ${peer} with an X-Forwarded-For header, but MARGINALIA_TRUSTED_PROXY_HOPS is 0. ` +
      'Per-client rate limits are keying on the proxy, so every visitor shares one budget. ' +
      'Set MARGINALIA_TRUSTED_PROXY_HOPS to the number of reverse proxies you control in front of this server.',
  );
}

/**
 * The opposite misconfiguration: more hops configured than actually
 * arrive. Worth its own line because it degrades silently — every
 * request falls back to the shared socket-peer bucket, which looks
 * exactly like working software until someone is throttled by a
 * stranger's traffic.
 */
function warnAboutShortChain(actual: number, configured: number): void {
  if (warnedAboutChain) return;
  warnedAboutChain = true;
  console.warn(
    `[marginalia] MARGINALIA_TRUSTED_PROXY_HOPS is ${configured} but X-Forwarded-For arrived with ${actual} entr${actual === 1 ? 'y' : 'ies'}. ` +
      'Falling back to the connecting address, so per-client rate limits are shared. ' +
      'Set it to the number of proxies actually in front of this server.',
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
