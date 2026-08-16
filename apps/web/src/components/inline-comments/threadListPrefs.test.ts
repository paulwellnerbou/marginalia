/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import {
  DEFAULT_THREAD_FILTERS,
  DEFAULT_THREAD_FILTERS_OPEN,
  DEFAULT_THREAD_SORT_MODE,
  loadThreadFilters,
  loadThreadFiltersOpen,
  loadThreadSortMode,
  saveThreadFilters,
  saveThreadFiltersOpen,
  saveThreadSortMode,
} from './threadListPrefs.js';

// Bun has no Web Storage — the module reads it lazily, so a plain stub is enough.
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});

beforeEach(() => store.clear());

test('an untouched browser gets the shipped defaults', () => {
  expect(loadThreadSortMode()).toBe('latest');
  expect(loadThreadFilters()).toEqual({ status: 'unresolved', kind: 'all', replies: 'all' });
  expect(loadThreadFiltersOpen()).toBe(true);

  expect(DEFAULT_THREAD_SORT_MODE).toBe('latest');
  expect(DEFAULT_THREAD_FILTERS).toEqual({ status: 'unresolved', kind: 'all', replies: 'all' });
  expect(DEFAULT_THREAD_FILTERS_OPEN).toBe(true);
});

test('round-trips every setting', () => {
  saveThreadSortMode('document');
  saveThreadFilters({ status: 'all', kind: 'proposals', replies: 'unanswered' });
  saveThreadFiltersOpen(false);

  expect(loadThreadSortMode()).toBe('document');
  expect(loadThreadFilters()).toEqual({ status: 'all', kind: 'proposals', replies: 'unanswered' });
  expect(loadThreadFiltersOpen()).toBe(false);
});

test('non-default values that match a default still round-trip', () => {
  saveThreadFilters({ status: 'all', kind: 'all', replies: 'all' });
  expect(loadThreadFilters()).toEqual({ status: 'all', kind: 'all', replies: 'all' });
});

test('junk falls back per dimension, leaving the other one intact', () => {
  store.set('marginalia.threadListSort', 'oldest');
  store.set('marginalia.threadListStatus', 'resolved');
  store.set('marginalia.threadListKind', 'proposals');
  store.set('marginalia.threadListReplies', 'answered');

  expect(loadThreadSortMode()).toBe('latest');
  expect(loadThreadFilters()).toEqual({
    status: 'unresolved',
    kind: 'proposals',
    replies: 'all',
  });
});

// A browser that last used the pane before this filter existed has no key
// for it; it must open unfiltered rather than hiding the reader's own threads.
test('a browser with no stored replies filter keeps every thread', () => {
  store.set('marginalia.threadListStatus', 'all');
  expect(loadThreadFilters().replies).toBe('all');
});

test('only a literal "true" keeps the filter row open', () => {
  store.set('marginalia.threadListFiltersOpen', 'yes');
  expect(loadThreadFiltersOpen()).toBe(false);
  store.set('marginalia.threadListFiltersOpen', 'true');
  expect(loadThreadFiltersOpen()).toBe(true);
});
