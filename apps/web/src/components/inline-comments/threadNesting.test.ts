/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Comment, Thread } from '../../lib/api.js';
import {
  computeAnchoredThreadNesting,
  computeThreadNesting,
  nestedThreadsOf,
} from './threadNesting.js';

function comment(id: string, body: string, author = 'Paul'): Comment {
  return {
    id,
    body,
    author: { client_id: `client-${author}`, display_name: author },
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
      reopen: false,
    },
    comments: [comment(id, `body of ${id}`)],
    answered_by_thread_ids: [],
    proposal: null,
    ...overrides,
  };
}

function proposal(id: string, answersId: string | null, overrides: Partial<Thread> = {}): Thread {
  return thread(id, {
    proposal: {
      whole_document: false,
      answers_thread_id: answersId,
      // Nesting keys off `answers_thread_id` alone; the branch-derived
      // text fields just have to be present.
      proposed_text: null,
      source_snapshot: null,
    },
    ...overrides,
  });
}

/** A thread the server has unlinked from the document: no anchor left. */
function orphaned(t: Thread): Thread {
  return {
    ...t,
    link_status: 'orphaned',
    anchor: { ...t.anchor, block_id: null, quote: null, start_offset: null, end_offset: null },
  };
}

test('a proposal nests under the thread it answers', () => {
  const parent = thread('C', { answered_by_thread_ids: ['P'] });
  const p = proposal('P', 'C');
  const nesting = computeThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C']);
  expect(nestedThreadsOf(nesting, 'C').map((t) => t.id)).toEqual(['P']);
  expect(nesting.parentOf.get('P')).toBe('C');
});

test('multiple proposals keep the answered_by order (oldest first)', () => {
  const parent = thread('C', { answered_by_thread_ids: ['P1', 'P2'] });
  const p1 = proposal('P1', 'C');
  const p2 = proposal('P2', 'C');
  const nesting = computeThreadNesting([p2, parent, p1]);
  expect(nestedThreadsOf(nesting, 'C').map((t) => t.id)).toEqual(['P1', 'P2']);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C']);
});

test('a proposal whose answered thread is absent stays top-level', () => {
  const p = proposal('P', 'C');
  const nesting = computeThreadNesting([p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['P']);
  expect(nesting.nestedByParent.size).toBe(0);
});

test('standalone proposals and plain threads stay top-level', () => {
  const plain = thread('C');
  const standalone = proposal('P', null);
  const nesting = computeThreadNesting([plain, standalone]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C', 'P']);
  expect(nesting.parentOf.size).toBe(0);
});

test('a proposal that does not name this parent back is not nested', () => {
  // The two link directions come from one server column, but the thread
  // array can mix threads fetched at different times. A reverse index
  // that has drifted must not file a proposal under a comment it no
  // longer answers.
  const parent = thread('C', { answered_by_thread_ids: ['P'] });
  const p = proposal('P', 'OTHER');
  const nesting = computeThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C', 'P']);
  expect(nesting.nestedByParent.size).toBe(0);
  expect(nesting.parentOf.size).toBe(0);
});

test('a standalone proposal listed by a stale reverse index is not nested', () => {
  const parent = thread('C', { answered_by_thread_ids: ['P'] });
  const p = proposal('P', null);
  const nesting = computeThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C', 'P']);
  expect(nesting.nestedByParent.size).toBe(0);
});

test('anchored placement keeps an anchored proposal out of an orphaned parent', () => {
  // The margin column and the floating popover place every card at its
  // thread's anchor, and an orphaned parent has none — merging would
  // park the proposal at the foot of the column while its highlight
  // stayed behind in the text.
  const parent = orphaned(thread('C', { answered_by_thread_ids: ['P'] }));
  const p = proposal('P', 'C');
  const nesting = computeAnchoredThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C', 'P']);
  expect(nesting.nestedByParent.size).toBe(0);
  expect(nesting.parentOf.size).toBe(0);
});

test('a flat list still merges an anchored proposal into an orphaned parent', () => {
  const parent = orphaned(thread('C', { answered_by_thread_ids: ['P'] }));
  const p = proposal('P', 'C');
  const nesting = computeThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C']);
  expect(nestedThreadsOf(nesting, 'C').map((t) => t.id)).toEqual(['P']);
});

test('anchored placement still merges a proposal that has no anchor of its own', () => {
  // Whole-document proposals carry no block id, so the answered
  // thread's card is the only place they can sensibly render.
  const parent = thread('C', { answered_by_thread_ids: ['P'] });
  const p = orphaned(proposal('P', 'C'));
  const nesting = computeAnchoredThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C']);
  expect(nestedThreadsOf(nesting, 'C').map((t) => t.id)).toEqual(['P']);
});

test('anchored placement merges when neither thread has an anchor', () => {
  const parent = orphaned(thread('C', { answered_by_thread_ids: ['P'] }));
  const p = orphaned(proposal('P', 'C'));
  const nesting = computeAnchoredThreadNesting([parent, p]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C']);
  expect(nestedThreadsOf(nesting, 'C').map((t) => t.id)).toEqual(['P']);
});

test('an answered_by id pointing at a non-proposal is ignored', () => {
  // Defensive: the server never produces this, but a stale id must not
  // swallow a comment thread into another card.
  const parent = thread('C', { answered_by_thread_ids: ['X'] });
  const other = thread('X');
  const nesting = computeThreadNesting([parent, other]);
  expect(nesting.topLevel.map((t) => t.id)).toEqual(['C', 'X']);
  expect(nesting.nestedByParent.size).toBe(0);
});
