/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';

/**
 * The subscription lifecycle, which the home page relies on: the panel
 * mounts, listens for connect/disconnect/rotate, and must leave nothing
 * behind when it unmounts. Callers wire the returned function up as a
 * React effect cleanup, so a leak here would accumulate a listener per
 * mount for the life of the tab.
 *
 * Plus what a pull reports back, which is what the home page turns into
 * the "syncing stopped" notice.
 */

interface Listener {
  type: string;
  fn: EventListenerOrEventListenerObject;
}

let listeners: Listener[];

function installDom(): void {
  listeners = [];
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      listeners.push({ type, fn });
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const l of [...listeners]) {
        if (l.type !== event.type) continue;
        if (typeof l.fn === 'function') l.fn(event as unknown as Event);
      }
      return true;
    },
  };
  (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

/** Answer the next fetch with this status and body, whatever the URL. */
function stubFetch(status: number, body: unknown): void {
  (globalThis as { fetch?: unknown }).fetch = () =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

beforeEach(() => {
  installDom();
});

test('unsubscribing removes every listener it added', async () => {
  const { onKeyringChange } = await import('./keyring.js');

  const before = listeners.length;
  const unsubscribe = onKeyringChange(() => {});
  // Both the in-app event and the cross-tab `storage` channel.
  expect(listeners.length).toBe(before + 2);

  unsubscribe();
  expect(listeners.length).toBe(before);
});

test('repeated subscribe/unsubscribe cycles do not accumulate listeners', async () => {
  const { onKeyringChange } = await import('./keyring.js');

  const before = listeners.length;
  for (let i = 0; i < 5; i++) onKeyringChange(() => {})();
  expect(listeners.length).toBe(before);
});

test('a pull that finds no ring drops the token and says so', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(404, { error: 'not-found' });

  const pull = await pullKeyring();
  // The pair the home page needs: something to say, and a reason to say
  // it. Without `dropped` the panel just silently flips to disconnected.
  expect(pull.dropped).toBe(true);
  expect(pull.docs).toBeNull();
  expect(localStorage.getItem('marginalia.keyring')).toBeNull();
});

test('a pull carries the idle window back for the panel to quote', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, {
    client_id: 'aaaaaaaaaaaaaaaaaaaa',
    display_name: 'Paul',
    idle_ttl_ms: 180 * 24 * 60 * 60 * 1000,
    docs: [],
  });

  const pull = await pullKeyring();
  expect(pull.dropped).toBe(false);
  expect(pull.idleTtlMs).toBe(180 * 24 * 60 * 60 * 1000);
  expect(localStorage.getItem('marginalia.keyring')).toBe('tok');
});

test('an older overlapping pull cannot land after a newer snapshot', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  const responders: Array<(response: Response) => void> = [];
  (globalThis as { fetch?: unknown }).fetch = () =>
    new Promise<Response>((resolve) => responders.push(resolve));

  const older = pullKeyring();
  const newer = pullKeyring();
  const response = (idleTtlMs: number) =>
    new Response(
      JSON.stringify({
        client_id: 'aaaaaaaaaaaaaaaaaaaa',
        display_name: 'Paul',
        idle_ttl_ms: idleTtlMs,
        docs: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  responders[1]?.(response(222));
  expect((await newer).idleTtlMs).toBe(222);

  responders[0]?.(response(111));
  expect((await older).idleTtlMs).toBeNull();
});

test('a pull that fails for any other reason keeps the token', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(500, { error: 'boom' });

  const pull = await pullKeyring();
  // A server having a bad minute must not read as "your ring is gone" —
  // that would drop a live credential and show the wrong notice.
  expect(pull.dropped).toBe(false);
  expect(localStorage.getItem('marginalia.keyring')).toBe('tok');
});

test('an unsubscribed listener stops hearing changes', async () => {
  const { disconnectKeyring, onKeyringChange } = await import('./keyring.js');

  const seen: Array<string | null> = [];
  const unsubscribe = onKeyringChange((token) => seen.push(token));

  localStorage.setItem('marginalia.keyring', 'tok');
  disconnectKeyring();
  expect(seen).toEqual([null]);

  unsubscribe();
  localStorage.setItem('marginalia.keyring', 'tok');
  disconnectKeyring();
  expect(seen).toEqual([null]);
});
