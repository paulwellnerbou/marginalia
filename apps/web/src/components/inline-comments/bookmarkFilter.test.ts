/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import type { Thread } from '../../lib/api.js';
import {
  bookmarkFilterSplits,
  countBookmarkCards,
  loadBookmarkFilter,
  matchesBookmarkFilter,
  saveBookmarkFilter,
} from './bookmarkFilter.js';

// Bun has no Web Storage; reinstalled per test so a sibling file's stub can't win.
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

function thread(id: string, { bookmark = false, own = false, hidden = false } = {}): Thread {
  return {
    id,
    state: 'open',
    resolution: null,
    link_status: 'linked',
    bookmark,
    anchor: {
      block_id: 'block-1',
      end_block_id: null,
      quote: 'the anchored words',
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: 18,
      heading_path: null,
      section_index: null,
      section_index_path: null,
    },
    capabilities: {
      reply: true,
      resolve: true,
      accept: false,
      reject: false,
      update: false,
      repair: false,
      resolve_conflict: false,
      reopen: false,
    },
    comments: [
      {
        id: `${id}-c`,
        body: '',
        author: { client_id: 'someone', display_name: 'Someone' },
        capabilities: { edit: own, delete: own, react: true },
        reactions: [],
        hidden,
        created_at: 0,
        updated_at: 0,
      },
    ],
    answered_by_thread_ids: [],
    proposal: null,
  } as Thread;
}

const ownPrivate = thread('own-private', { bookmark: true, own: true, hidden: true });
const ownShared = thread('own-shared', { bookmark: true, own: true });
const othersShared = thread('others', { bookmark: true });
// Someone else's comment thread the viewer starred.
const starred = thread('starred');

const pick = (filter: 'all' | 'shared' | 'mine') =>
  [ownPrivate, ownShared, othersShared, starred]
    .filter((t) => matchesBookmarkFilter(t, filter))
    .map((t) => t.id);

test('all keeps everything', () => {
  expect(pick('all')).toEqual(['own-private', 'own-shared', 'others', 'starred']);
});

test('shared keeps the passage bookmarks everyone can see, whoever made them', () => {
  expect(pick('shared')).toEqual(['own-shared', 'others']);
});

test("mine keeps the viewer's passage bookmarks and every starred thread", () => {
  expect(pick('mine')).toEqual(['own-private', 'own-shared', 'starred']);
});

test('the filter is only worth offering when it tells bookmarks apart', () => {
  expect(bookmarkFilterSplits([])).toBe(false);
  expect(bookmarkFilterSplits([ownPrivate, starred])).toBe(false);
  expect(bookmarkFilterSplits([ownShared, ownShared])).toBe(false);
  expect(bookmarkFilterSplits([ownPrivate, ownShared])).toBe(true);
  expect(bookmarkFilterSplits([ownShared, othersShared])).toBe(true);
});

test('the badge counts the cards the filter lists', () => {
  const all = [ownPrivate, ownShared, othersShared, starred];
  expect(countBookmarkCards(all, 'all')).toBe(4);
  expect(countBookmarkCards(all, 'shared')).toBe(2);
  expect(countBookmarkCards(all, 'mine')).toBe(3);
});

test('the choice is remembered per document', () => {
  saveBookmarkFilter('d1', 'mine');
  expect(loadBookmarkFilter('d1')).toBe('mine');
  expect(loadBookmarkFilter('d2')).toBe('all');
});

test('an unknown stored value shows everything', () => {
  store.set('marginalia.view.d1', JSON.stringify({ bookmarkListFilter: 'public' }));
  expect(loadBookmarkFilter('d1')).toBe('all');
});
