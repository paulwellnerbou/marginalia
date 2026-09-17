/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import { forgetLegacyBookmarkedThreadIds, legacyBookmarkedThreadIds } from './bookmarkedThreads.js';

const KEY = 'marginalia.bookmarkedThreads';

// Bun has no Web Storage. Reinstalled before each test rather than once at
// load: the whole suite shares one global, and a sibling file's stub would
// otherwise win by evaluation order.
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
});

test('a browser that never kept bookmarks locally has none to upload', () => {
  expect(legacyBookmarkedThreadIds('doc-1')).toEqual([]);
});

test("reads one document's locally kept bookmarks, as the old store wrote them", () => {
  store.set(KEY, JSON.stringify({ 'doc-1': ['t1', 't2'], 'doc-2': ['t3'] }));
  expect(legacyBookmarkedThreadIds('doc-1')).toEqual(['t1', 't2']);
  expect(legacyBookmarkedThreadIds('doc-2')).toEqual(['t3']);
});

test('a corrupt store reads as no bookmarks rather than throwing', () => {
  store.set(KEY, 'not json');
  expect(legacyBookmarkedThreadIds('doc-1')).toEqual([]);

  store.set(KEY, JSON.stringify({ 'doc-1': 'nope', 'doc-2': ['t3', 4] }));
  expect(legacyBookmarkedThreadIds('doc-1')).toEqual([]);
  expect(legacyBookmarkedThreadIds('doc-2')).toEqual(['t3']);
});

test("forgetting one document's bookmarks keeps the others, and the last takes the key", () => {
  store.set(KEY, JSON.stringify({ 'doc-1': ['t1'], 'doc-2': ['t3'] }));

  forgetLegacyBookmarkedThreadIds('doc-1');
  expect(legacyBookmarkedThreadIds('doc-1')).toEqual([]);
  expect(legacyBookmarkedThreadIds('doc-2')).toEqual(['t3']);

  forgetLegacyBookmarkedThreadIds('doc-2');
  expect(store.has(KEY)).toBe(false);
});
