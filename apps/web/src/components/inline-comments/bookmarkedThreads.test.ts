/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import {
  loadBookmarkedThreadIds,
  onBookmarkedThreadsChange,
  toggleBookmarkedThread,
} from './bookmarkedThreads.js';

// Bun has no Web Storage and no `window`, and the module reads them lazily.
// Reinstall the stubs before each test rather than once at load: the whole
// suite shares one global, and a sibling file's stub wins by evaluation order
// otherwise — open-tabs.test installs a `CustomEvent` with no `.type`, which
// this bus needs to route an event. `window` is a self-contained bus, not the
// native one, so a foreign Event class can't make dispatchEvent reject it.
const store = new Map<string, string>();
const listeners = new Map<string, Set<(e: { type: string }) => void>>();

beforeEach(() => {
  store.clear();
  listeners.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (e: { type: string }) => {
        for (const fn of listeners.get(e.type) ?? []) fn(e);
        return true;
      },
      addEventListener: (type: string, fn: (e: { type: string }) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: { type: string }) => void) => {
        listeners.get(type)?.delete(fn);
      },
    },
  });
});

test('an untouched document has no bookmarks', () => {
  expect([...loadBookmarkedThreadIds('doc-1')]).toEqual([]);
});

test('toggling adds then removes a thread, and round-trips through storage', () => {
  toggleBookmarkedThread('doc-1', 't1');
  expect(loadBookmarkedThreadIds('doc-1').has('t1')).toBe(true);

  toggleBookmarkedThread('doc-1', 't2');
  expect([...loadBookmarkedThreadIds('doc-1')].sort()).toEqual(['t1', 't2']);

  toggleBookmarkedThread('doc-1', 't1');
  expect([...loadBookmarkedThreadIds('doc-1')]).toEqual(['t2']);
});

test('bookmarks are scoped per document', () => {
  toggleBookmarkedThread('doc-1', 't1');
  toggleBookmarkedThread('doc-2', 't1');
  toggleBookmarkedThread('doc-2', 't2');

  expect([...loadBookmarkedThreadIds('doc-1')]).toEqual(['t1']);
  expect([...loadBookmarkedThreadIds('doc-2')].sort()).toEqual(['t1', 't2']);
});

test("emptying a document's bookmarks leaves nothing behind", () => {
  toggleBookmarkedThread('doc-1', 't1');
  toggleBookmarkedThread('doc-1', 't1');
  // The whole document key is dropped once its last bookmark goes.
  expect(store.get('marginalia.bookmarkedThreads')).toBe('{}');
});

test('a corrupt store degrades to no bookmarks rather than throwing', () => {
  store.set('marginalia.bookmarkedThreads', 'not json');
  expect([...loadBookmarkedThreadIds('doc-1')]).toEqual([]);

  store.set('marginalia.bookmarkedThreads', '{"doc-1":"nope"}');
  expect([...loadBookmarkedThreadIds('doc-1')]).toEqual([]);
});

test('subscribers hear an in-app toggle for their document only', () => {
  let doc1Calls = 0;
  let doc2Calls = 0;
  const off1 = onBookmarkedThreadsChange('doc-1', () => doc1Calls++);
  const off2 = onBookmarkedThreadsChange('doc-2', () => doc2Calls++);

  // Both subscribers fire (the channel is document-agnostic), but each
  // recomputes its own document's set — doc-2's stays empty.
  toggleBookmarkedThread('doc-1', 't1');
  expect(doc1Calls).toBe(1);
  expect(doc2Calls).toBe(1);
  expect(loadBookmarkedThreadIds('doc-2').size).toBe(0);

  off1();
  off2();
});
