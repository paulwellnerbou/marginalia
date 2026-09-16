/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { type Comment, isBookmark, type Thread } from './api.js';
import { bookmarkMarkerSpecs } from './bookmark-markers.js';

function comment(id: string, body: string): Comment {
  return {
    id,
    body,
    author: { client_id: 'client-paul', display_name: 'Paul' },
    capabilities: { edit: true, delete: true, react: true },
    reactions: [],
    created_at: 0,
    updated_at: 0,
  };
}

function thread(id: string, body: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    state: 'open',
    resolution: null,
    link_status: 'linked',
    anchor: {
      block_id: `block-${id}`,
      end_block_id: null,
      quote: 'A paragraph.',
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: 12,
      heading_path: ['Chapter one'],
      section_index: 2,
      section_index_path: [0, 2],
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
    comments: [comment(id, body)],
    answered_by_thread_ids: [],
    proposal: null,
    ...overrides,
  };
}

const bookmark = { bookmark: true } as const;

test('a thread is a bookmark only when the server flags it, whatever its body', () => {
  expect(isBookmark(thread('b', '', bookmark))).toBe(true);
  expect(isBookmark(thread('c', 'A remark'))).toBe(false);
  // The iOS app reads a thread with no text and no flag as a highlight.
  expect(isBookmark(thread('e', ''))).toBe(false);
});

test('only anchored bookmarks get a marker, carrying the section that picks their block', () => {
  const specs = bookmarkMarkerSpecs([
    thread('c', 'A remark'),
    thread('e', ''),
    thread('b', '', bookmark),
    thread('lost', '', { ...bookmark, link_status: 'orphaned' }),
  ]);
  expect(specs).toEqual([
    {
      threadId: 'b',
      blockId: 'block-b',
      quote: 'A paragraph.',
      section: {
        heading_path: ['Chapter one'],
        section_index: 2,
        section_index_path: [0, 2],
      },
    },
  ]);
});
