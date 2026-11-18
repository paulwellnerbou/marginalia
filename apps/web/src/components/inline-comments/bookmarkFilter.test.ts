/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Thread } from '../../lib/api.js';
import { bookmarkFilterSplits, matchesBookmarkFilter } from './bookmarkFilter.js';

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
