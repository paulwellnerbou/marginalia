/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Comment, Thread } from '../../lib/api.js';
import { ALL_THREAD_FILTERS, type ThreadFilters } from './threadFilters.js';
import { buildThreadListCards, countThreadListCards } from './threadListCards.js';

function comment(id: string, author = 'Paul'): Comment {
  return {
    id,
    body: `body of ${id}`,
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
      resolve_conflict: false,
      reopen: false,
    },
    comments: [comment(id)],
    answered_by_thread_ids: [],
    proposal: null,
    ...overrides,
  };
}

function proposal(id: string, answers: string[], overrides: Partial<Thread> = {}): Thread {
  return thread(id, {
    proposal: {
      whole_document: false,
      answers_thread_ids: answers,
      proposed_text: null,
      source_snapshot: null,
    },
    ...overrides,
  });
}

const resolved = { state: 'resolved' } as const;
const UNRESOLVED: ThreadFilters = { ...ALL_THREAD_FILTERS, status: 'unresolved' };

test('a proposal answering a comment is one card with it', () => {
  const { cards, parentOf } = buildThreadListCards([
    thread('C', { answered_by_thread_ids: ['P'] }),
    proposal('P', ['C']),
  ]);
  expect(cards.map((c) => c.thread.id)).toEqual(['C']);
  expect(cards[0]?.nested.map((n) => n.id)).toEqual(['P']);
  expect(parentOf.get('P')).toBe('C');
});

test('an orphaned proposal keeps its own card instead of nesting into a linked one', () => {
  const { cards } = buildThreadListCards([
    thread('C', { answered_by_thread_ids: ['P'] }),
    proposal('P', ['C'], { link_status: 'orphaned' }),
  ]);
  expect(cards.map((c) => [c.thread.id, c.isOrphan])).toEqual([
    ['C', false],
    ['P', true],
  ]);
});

test('the count leaves out what the filters hide, not the raw total', () => {
  const { cards } = buildThreadListCards([
    thread('OPEN'),
    thread('DONE-1', resolved),
    thread('DONE-2', resolved),
  ]);
  expect(countThreadListCards(cards, UNRESOLVED, null, null)).toBe(1);
  expect(countThreadListCards(cards, ALL_THREAD_FILTERS, null, null)).toBe(3);
});

test('the thread the tab is about to reveal counts once, on top of the filtered cards', () => {
  const { cards } = buildThreadListCards([thread('OPEN'), thread('DONE', resolved)]);
  expect(countThreadListCards(cards, UNRESOLVED, null, 'DONE')).toBe(2);
  expect(countThreadListCards(cards, UNRESOLVED, null, 'OPEN')).toBe(1);
});

test('revealing a nested proposal counts the card it renders in', () => {
  const { cards } = buildThreadListCards([
    thread('C', { ...resolved, answered_by_thread_ids: ['P'] }),
    proposal('P', ['C'], resolved),
    thread('OPEN'),
  ]);
  expect(countThreadListCards(cards, UNRESOLVED, null, 'P')).toBe(2);
});
