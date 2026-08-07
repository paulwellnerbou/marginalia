/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';

/**
 * The subscription lifecycle, which the home page relies on: the panel
 * mounts, listens for connect/disconnect/rotate, and must leave nothing
 * behind when it unmounts. Callers wire the returned function up as a
 * React effect cleanup, so a leak here would accumulate a listener per
 * mount for the life of the tab.
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
