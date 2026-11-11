/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import { writeDocViewPref } from '../../lib/doc-view-prefs.js';
import {
  DEFAULT_THREAD_FILTERS,
  DEFAULT_THREAD_SORT_MODE,
  loadThreadFilters,
  loadThreadSortMode,
  saveThreadFilters,
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
  expect(loadThreadSortMode('d1')).toBe('latest');
  expect(loadThreadFilters('d1')).toEqual({ status: 'unresolved', kind: 'all', replies: 'all' });

  expect(DEFAULT_THREAD_SORT_MODE).toBe('latest');
  expect(DEFAULT_THREAD_FILTERS).toEqual({ status: 'unresolved', kind: 'all', replies: 'all' });
});

test('round-trips every setting', () => {
  writeDocViewPref('d1', 'threadListSort', 'document');
  saveThreadFilters('d1', { status: 'all', kind: 'proposals', replies: 'unanswered' });

  expect(loadThreadSortMode('d1')).toBe('document');
  expect(loadThreadFilters('d1')).toEqual({
    status: 'all',
    kind: 'proposals',
    replies: 'unanswered',
  });
});

test('non-default values that match a default still round-trip', () => {
  saveThreadFilters('d1', { status: 'all', kind: 'all', replies: 'all' });
  expect(loadThreadFilters('d1')).toEqual({ status: 'all', kind: 'all', replies: 'all' });
});

test('junk in the old per-browser keys falls back per dimension, leaving the other one intact', () => {
  store.set('marginalia.threadListSort', 'oldest');
  store.set('marginalia.threadListStatus', 'resolved');
  store.set('marginalia.threadListKind', 'proposals');
  store.set('marginalia.threadListReplies', 'answered');

  expect(loadThreadSortMode('d1')).toBe('latest');
  expect(loadThreadFilters('d1')).toEqual({
    status: 'unresolved',
    kind: 'proposals',
    replies: 'all',
  });
});

// A browser that last used the pane before this filter existed has no key
// for it; it must open unfiltered rather than hiding the reader's own threads.
test('a browser with no stored replies filter keeps every thread', () => {
  store.set('marginalia.threadListStatus', 'all');
  expect(loadThreadFilters('d1').replies).toBe('all');
});

test('each document keeps its own sort and filters', () => {
  writeDocViewPref('d1', 'threadListSort', 'document');
  saveThreadFilters('d1', { status: 'all', kind: 'proposals', replies: 'unanswered' });

  expect(loadThreadSortMode('d2')).toBe('latest');
  expect(loadThreadFilters('d2')).toEqual(DEFAULT_THREAD_FILTERS);
});
