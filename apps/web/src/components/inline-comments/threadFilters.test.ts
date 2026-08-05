/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Comment, Thread } from '../../lib/api.js';
import { normalizeThreadSearch, threadMatchesSearch } from './threadFilters.js';

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

function thread(
  id: string,
  comments: [Comment, ...Comment[]],
  quote = 'the anchored words',
): Thread {
  return {
    id,
    state: 'open',
    resolution: null,
    link_status: 'linked',
    anchor: {
      block_id: 'block-1',
      end_block_id: null,
      quote,
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: quote.length,
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
    comments,
    answered_by_thread_ids: [],
    proposal: null,
  };
}

const SAMPLE = thread('wk43qH0PT_JtMxUU', [
  comment('wk43qH0PT_JtMxUU', 'Opening rationale.'),
  comment('ZfLgvxNtxrIYlw6I', 'Addressed in edit proposal `abc`.', 'Claude'),
]);

test('empty query matches everything', () => {
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch(''))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('   '))).toBe(true);
});

test('matches the thread id, case-insensitively and on a fragment', () => {
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('wk43qH0PT_JtMxUU'))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('WK43QH0PT'))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('JtMxUU'))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('nope-not-here'))).toBe(false);
});

test('matches the id of a reply, not only the opener', () => {
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('ZfLgvxNtxrIYlw6I'))).toBe(true);
});

test('a pasted comment link or fragment means its id', () => {
  const link = 'https://marginalia.test/d/some-doc-uid#comment-ZfLgvxNtxrIYlw6I';
  expect(normalizeThreadSearch(link)).toBe('zflgvxntxriylw6i');
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch(link))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('#comment-ZfLgvxNtxrIYlw6I'))).toBe(
    true,
  );
  // The rest of the URL must not be required to match anything.
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('https://marginalia.test/'))).toBe(
    false,
  );
});

test('matches author names and message bodies', () => {
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('claude'))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('rationale'))).toBe(true);
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('edit proposal'))).toBe(true);
});

test('matches the anchored quote', () => {
  expect(threadMatchesSearch(SAMPLE, normalizeThreadSearch('anchored words'))).toBe(true);
});
