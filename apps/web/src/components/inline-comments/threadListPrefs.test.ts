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
  expect(loadThreadFilters()).toEqual({ status: 'unresolved', kind: 'all' });
  expect(loadThreadFiltersOpen()).toBe(true);

  expect(DEFAULT_THREAD_SORT_MODE).toBe('latest');
  expect(DEFAULT_THREAD_FILTERS).toEqual({ status: 'unresolved', kind: 'all' });
  expect(DEFAULT_THREAD_FILTERS_OPEN).toBe(true);
});

test('round-trips every setting', () => {
  saveThreadSortMode('document');
  saveThreadFilters({ status: 'all', kind: 'proposals' });
  saveThreadFiltersOpen(false);

  expect(loadThreadSortMode()).toBe('document');
  expect(loadThreadFilters()).toEqual({ status: 'all', kind: 'proposals' });
  expect(loadThreadFiltersOpen()).toBe(false);
});

test('non-default values that match a default still round-trip', () => {
  saveThreadFilters({ status: 'all', kind: 'all' });
  expect(loadThreadFilters()).toEqual({ status: 'all', kind: 'all' });
});

test('junk falls back per dimension, leaving the other one intact', () => {
  store.set('marginalia.threadListSort', 'oldest');
  store.set('marginalia.threadListStatus', 'resolved');
  store.set('marginalia.threadListKind', 'proposals');

  expect(loadThreadSortMode()).toBe('latest');
  expect(loadThreadFilters()).toEqual({ status: 'unresolved', kind: 'proposals' });
});

test('only a literal "true" keeps the filter row open', () => {
  store.set('marginalia.threadListFiltersOpen', 'yes');
  expect(loadThreadFiltersOpen()).toBe(false);
  store.set('marginalia.threadListFiltersOpen', 'true');
  expect(loadThreadFiltersOpen()).toBe(true);
});
