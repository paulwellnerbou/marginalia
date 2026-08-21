/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { Comment, Thread } from '../../lib/api.js';
import {
  ALL_THREAD_FILTERS,
  normalizeThreadSearch,
  showThreadListControls,
  type ThreadFilters,
  threadListEmptyMessage,
  threadMatchesSearch,
} from './threadFilters.js';

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
      resolve_conflict: false,
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

const UNRESOLVED_ONLY: ThreadFilters = { status: 'unresolved', kind: 'all', replies: 'all' };

function controls(over: Partial<Parameters<typeof showThreadListControls>[0]> = {}) {
  return showThreadListControls({
    totalCards: 0,
    resolvedCount: 0,
    searching: false,
    filters: UNRESOLVED_ONLY,
    ...over,
  });
}

function emptyMessage(over: Partial<Parameters<typeof threadListEmptyMessage>[0]> = {}) {
  return threadListEmptyMessage({
    totalCards: 0,
    resolvedCount: 0,
    sectionFilterCount: 0,
    searching: false,
    filters: UNRESOLVED_ONLY,
    canComment: true,
    ...over,
  });
}

test('the control row survives a filter that hides every thread there is', () => {
  // The archive is unread, so the list holds nothing to count — only the
  // document's own tally says the chips still have something to reveal.
  expect(controls({ totalCards: 0, resolvedCount: 4 })).toBe(true);
  expect(emptyMessage({ totalCards: 0, resolvedCount: 4 })).toBe(
    'No threads match the selected filters.',
  );
});

test('a document with nothing to filter gets no control row', () => {
  expect(controls({ totalCards: 0, resolvedCount: 0 })).toBe(false);
  expect(controls({ totalCards: 1, resolvedCount: 0, filters: ALL_THREAD_FILTERS })).toBe(false);
  expect(emptyMessage()).toBe('Select text in the document to comment.');
  expect(emptyMessage({ canComment: false })).toBe('You have read-only access to this document.');
});

test('one card left under a filter or search keeps its way back', () => {
  expect(controls({ totalCards: 1 })).toBe(true);
  expect(controls({ totalCards: 1, searching: true, filters: ALL_THREAD_FILTERS })).toBe(true);
  expect(controls({ totalCards: 2, filters: ALL_THREAD_FILTERS })).toBe(true);
});

test('settled threads alone do not raise the row when nothing is filtering', () => {
  // Nothing to undo: the archive read is on its way in and will fill the list.
  expect(controls({ totalCards: 0, resolvedCount: 4, filters: ALL_THREAD_FILTERS })).toBe(false);
});

test('the empty list gives the narrowest reason that applies', () => {
  expect(emptyMessage({ totalCards: 0, resolvedCount: 4, sectionFilterCount: 2 })).toBe(
    'No threads in the focused sections.',
  );
  expect(emptyMessage({ totalCards: 3, searching: true })).toBe('No threads match this search.');
  expect(emptyMessage({ totalCards: 3 })).toBe('No threads match the selected filters.');
});
