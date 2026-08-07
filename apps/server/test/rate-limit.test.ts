import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  clientKey,
  FixedWindowRateLimiter,
  isPrivateAddress,
  parseTrustedProxyHops,
  resetProxyWarning,
} from '../src/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  test('allows up to the limit, then refuses', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 1000 });
    const now = 10_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('a', now).allowed).toBe(true);
      limiter.record('a', now);
    }
    expect(limiter.check('a', now).allowed).toBe(false);
  });

  test('the window reopens once it elapses', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.record('a', 10_000);
    expect(limiter.check('a', 10_500).allowed).toBe(false);
    expect(limiter.check('a', 11_000).allowed).toBe(true);
  });

  test('retryAfterSec counts down to the reset and never reports zero', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 10_000 });
    limiter.record('a', 0);
    expect(limiter.check('a', 0).retryAfterSec).toBe(10);
    expect(limiter.check('a', 5_000).retryAfterSec).toBe(5);
    // 1ms left still has to round up — a Retry-After of 0 invites an
    // immediate retry that would just 429 again.
    expect(limiter.check('a', 9_999).retryAfterSec).toBe(1);
  });

  test('keys are independent', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.record('a', 0);
    expect(limiter.check('a', 0).allowed).toBe(false);
    expect(limiter.check('b', 0).allowed).toBe(true);
  });
});

describe('parseTrustedProxyHops', () => {
  test('unset means no proxy assumed', () => {
    // Deliberately unlike noctua-mail's default of 1: this image is also
    // run bare, where trusting the header would make the limit decorative.
    expect(parseTrustedProxyHops(undefined)).toBe(0);
    expect(parseTrustedProxyHops(null)).toBe(0);
    expect(parseTrustedProxyHops('')).toBe(0);
    expect(parseTrustedProxyHops('   ')).toBe(0);
  });

  test('accepts booleans and counts', () => {
    expect(parseTrustedProxyHops('true')).toBe(1);
    expect(parseTrustedProxyHops('YES')).toBe(1);
    expect(parseTrustedProxyHops('1')).toBe(1);
    expect(parseTrustedProxyHops('2')).toBe(2);
    expect(parseTrustedProxyHops(' 3 ')).toBe(3);
    expect(parseTrustedProxyHops('false')).toBe(0);
    expect(parseTrustedProxyHops('no')).toBe(0);
    expect(parseTrustedProxyHops('0')).toBe(0);
  });

  test('a typo fails closed instead of becoming a trusted topology', () => {
    // parseInt would read these as 1 and 2 — a fat-fingered value must
    // not quietly start trusting a header.
    expect(parseTrustedProxyHops('1.5')).toBe(0);
    expect(parseTrustedProxyHops('2abc')).toBe(0);
    expect(parseTrustedProxyHops('-1')).toBe(0);
    expect(parseTrustedProxyHops('nonsense')).toBe(0);
  });
});

describe('clientKey', () => {
  /** Drive a real Hono request so header parsing is exercised for real. */
  async function keyFor(headers: Record<string, string>, hops: number): Promise<string> {
    const app = new Hono();
    let seen = '';
    app.get('/', (c) => {
      seen = clientKey(c, hops);
      return c.text('ok');
    });
    await app.fetch(new Request('http://test/', { headers }));
    return seen;
  }

  test('ignores X-Forwarded-For when no hops are trusted', async () => {
    expect(await keyFor({ 'x-forwarded-for': '9.9.9.9' }, 0)).toBe('unknown');
  });

  test('takes the rightmost hop, which is the one our proxy appended', async () => {
    // A client that forges the header only controls the entries to the
    // left of what the proxy adds; reading the leftmost would let it mint
    // a fresh identity per request.
    expect(await keyFor({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, 1)).toBe('203.0.113.7');
  });

  test('a single-hop header is the client address', async () => {
    expect(await keyFor({ 'x-forwarded-for': '203.0.113.7' }, 1)).toBe('203.0.113.7');
  });

  test('counts back N hops for a chained topology', async () => {
    // Cloudflare → Caddy → us. Caddy appends the edge address it saw, so
    // the real client is second from the right. Reading only the
    // rightmost would bucket every visitor under one CF edge.
    const chained = { 'x-forwarded-for': '203.0.113.7, 172.68.1.1' };
    expect(await keyFor(chained, 2)).toBe('203.0.113.7');
    expect(await keyFor(chained, 1)).toBe('172.68.1.1');

    // And a forged entry at the far left stays harmless at 2 hops.
    expect(await keyFor({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 172.68.1.1' }, 2)).toBe(
      '203.0.113.7',
    );
  });

  test('a chain shorter than configured fails closed', async () => {
    // Configured for two proxies, one entry arrived: we cannot tell a
    // real hop from a spoof, so trust neither.
    expect(await keyFor({ 'x-forwarded-for': '9.9.9.9' }, 2)).toBe('unknown');
  });

  test('falls back to a shared bucket rather than no limit at all', async () => {
    expect(await keyFor({}, 1)).toBe('unknown');
    // An all-whitespace header must not resolve to an empty key that
    // silently collides with nothing.
    expect(await keyFor({ 'x-forwarded-for': ' , ' }, 1)).toBe('unknown');
  });
});

describe('isPrivateAddress', () => {
  test('recognises loopback and the RFC1918 ranges', () => {
    for (const addr of ['127.0.0.1', '10.1.2.3', '192.168.1.4', '172.16.0.1', '172.31.255.255']) {
      expect(isPrivateAddress(addr)).toBe(true);
    }
  });

  test('does not overshoot the 172.16/12 block', () => {
    // The classic off-by-one: 172.15 and 172.32 are public.
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });

  test('handles IPv6 loopback, unique-local, and v4-mapped addresses', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    // Bun reports a v4 peer over a dual-stack socket in this form.
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('rejects public addresses and junk', () => {
    for (const addr of ['8.8.8.8', '203.0.113.7', '', 'nonsense', '1.2.3']) {
      expect(isPrivateAddress(addr)).toBe(false);
    }
  });
});

/**
 * Over a real socket, because `getConnInfo` only works when a Bun server
 * is bound to the context — `app.hono.fetch(...)` in the other tests
 * never exercises it, so nothing else here proves the production path
 * resolves a peer address at all.
 */
describe('clientKey over a real server', () => {
  async function serving(
    hops: number,
    handler: (key: string) => void,
  ): Promise<{ url: string; stop: () => void }> {
    const app = new Hono();
    app.get('/', (c) => {
      handler(clientKey(c, hops));
      return c.text('ok');
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    return {
      url: `http://127.0.0.1:${server.port}/`,
      stop: () => void server.stop(true),
    };
  }

  test('resolves the real peer address when the proxy is not trusted', async () => {
    let key = '';
    const s = await serving(0, (k) => {
      key = k;
    });
    try {
      await fetch(s.url, { headers: { 'x-forwarded-for': '9.9.9.9' } });
      // The spoofed header is ignored; the socket peer wins.
      expect(key).not.toBe('9.9.9.9');
      expect(isPrivateAddress(key)).toBe(true);
    } finally {
      s.stop();
    }
  });

  test('warns once when a proxy is setting X-Forwarded-For and we ignore it', async () => {
    resetProxyWarning();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    const s = await serving(0, () => {});
    try {
      await fetch(s.url, { headers: { 'x-forwarded-for': '9.9.9.9' } });
      await fetch(s.url, { headers: { 'x-forwarded-for': '9.9.9.9' } });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('MARGINALIA_TRUSTED_PROXY_HOPS');
    } finally {
      console.warn = original;
      s.stop();
      resetProxyWarning();
    }
  });

  test('stays quiet when nothing in front is setting the header', async () => {
    // The plain no-proxy deployment. Nothing is misconfigured, so
    // printing deployment advice on every request would be noise.
    resetProxyWarning();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    const s = await serving(0, () => {});
    try {
      await fetch(s.url);
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = original;
      s.stop();
      resetProxyWarning();
    }
  });

  test('stays quiet once the proxy is trusted', async () => {
    resetProxyWarning();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    let key = '';
    const s = await serving(1, (k) => {
      key = k;
    });
    try {
      await fetch(s.url, { headers: { 'x-forwarded-for': '203.0.113.7' } });
      expect(key).toBe('203.0.113.7');
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = original;
      s.stop();
      resetProxyWarning();
    }
  });
});
