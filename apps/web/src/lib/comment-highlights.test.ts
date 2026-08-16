/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Comment, CommentAnchor, Thread } from './api.js';
import { buildCommentHighlights } from './comment-highlights.js';

const QUOTE = 'the anchored words';

function comment(id: string): Comment {
  return {
    id,
    body: `body of ${id}`,
    author: { client_id: 'client-paul', display_name: 'Paul' },
    capabilities: { edit: false, delete: false, react: true },
    reactions: [],
    created_at: 0,
    updated_at: 0,
  };
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    state: 'open',
    resolution: null,
    link_status: 'linked',
    anchor: {
      block_id: 'block-1',
      end_block_id: null,
      quote: QUOTE,
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: QUOTE.length,
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
    comments: [comment(id)],
    answered_by_thread_ids: [],
    proposal: null,
    ...overrides,
  };
}

function proposal(id: string, overrides: Partial<Thread> = {}): Thread {
  return thread(id, {
    proposal: {
      whole_document: false,
      answers_thread_ids: [],
      proposed_text: null,
      source_snapshot: null,
    },
    ...overrides,
  });
}

const resolved = { state: 'resolved' } as const;

test('an open comment paints its quoted range', () => {
  const highlights = buildCommentHighlights([thread('C')], { hideResolved: true });
  expect(highlights).toEqual([
    {
      scope: 'range',
      threadId: 'C',
      blockId: 'block-1',
      endBlockId: null,
      quote: QUOTE,
      startOffset: 0,
      endOffset: QUOTE.length,
      state: 'open',
    },
  ]);
});

test('resolved threads leave no mark — and so no click target — while hidden', () => {
  const highlights = buildCommentHighlights(
    [thread('C', resolved), proposal('P', resolved), thread('OPEN')],
    { hideResolved: true },
  );
  expect(highlights.map((h) => h.threadId)).toEqual(['OPEN']);
});

test('showing resolved brings their highlights back', () => {
  const highlights = buildCommentHighlights([thread('C', resolved), thread('OPEN')], {
    hideResolved: false,
  });
  expect(highlights.map((h) => h.threadId)).toEqual(['C', 'OPEN']);
  expect(highlights[0]?.state).toBe('resolved');
});

test('a resolved proposal never paints its block, even with resolved shown', () => {
  const highlights = buildCommentHighlights([proposal('P', resolved)], { hideResolved: false });
  expect(highlights).toEqual([]);
});

test('an open proposal paints the whole anchored block', () => {
  const highlights = buildCommentHighlights([proposal('P')], { hideResolved: true });
  expect(highlights[0]).toMatchObject({ scope: 'block', threadId: 'P', startOffset: 0 });
});

test('orphaned and anchorless threads paint nothing', () => {
  const noAnchor = thread('A', {
    link_status: 'orphaned',
    anchor: {
      ...thread('A').anchor,
      block_id: null as unknown as string,
      quote: null as unknown as string,
    },
  });
  const noQuote = thread('B', { anchor: { ...thread('B').anchor, quote: '' } });
  expect(buildCommentHighlights([noAnchor, noQuote], { hideResolved: true })).toEqual([]);
});

test('the anchor being composed paints without a thread id', () => {
  const pendingAnchor: CommentAnchor = {
    block_id: 'block-2',
    end_block_id: null,
    quote: 'fresh selection',
    prefix: '',
    suffix: '',
    start_offset: 3,
    end_offset: 18,
  };
  const highlights = buildCommentHighlights([], { hideResolved: true, pendingAnchor });
  expect(highlights).toEqual([
    {
      scope: 'range',
      blockId: 'block-2',
      endBlockId: null,
      quote: 'fresh selection',
      startOffset: 3,
      endOffset: 18,
    },
  ]);
});
