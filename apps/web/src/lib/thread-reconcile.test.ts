/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import type { Thread } from './api.js';
import {
  mergeArchiveThreads,
  mergeOpenThreads,
  threadContainingComment,
  threadIdOfComment,
} from './thread-reconcile.js';

function thread(id: string, createdAt: number, replyIds: string[] = []): Thread {
  return {
    id,
    comments: [
      { id: `${id}-root`, created_at: createdAt },
      ...replyIds.map((rid) => ({ id: rid, created_at: createdAt + 1 })),
    ],
  } as unknown as Thread;
}

describe('threadIdOfComment', () => {
  test('a root comment is its own thread', () => {
    expect(threadIdOfComment({ id: 'c1', parent_id: null, parent_proposal_id: null })).toBe('c1');
  });

  test('a reply names its thread through parent_id', () => {
    expect(threadIdOfComment({ id: 'c2', parent_id: 'root-1', parent_proposal_id: null })).toBe(
      'root-1',
    );
  });

  test('a proposal reply names its thread through parent_proposal_id', () => {
    expect(threadIdOfComment({ id: 'c3', parent_id: null, parent_proposal_id: 'prop-1' })).toBe(
      'prop-1',
    );
  });

  test('an unusable payload asks the caller to fall back', () => {
    expect(threadIdOfComment({})).toBeNull();
    expect(threadIdOfComment({ id: '' })).toBeNull();
    expect(threadIdOfComment({ id: 42 })).toBeNull();
  });
});

describe('threadContainingComment', () => {
  const threads = [thread('root-1', 1, ['reply-1']), thread('root-2', 2)];

  test('finds a root by its own id', () => {
    expect(threadContainingComment(threads, 'root-2')).toBe('root-2');
  });

  test('resolves a reply to the thread holding it', () => {
    expect(threadContainingComment(threads, 'reply-1')).toBe('root-1');
  });

  test('returns null for a comment no loaded thread holds', () => {
    expect(threadContainingComment(threads, 'stranger')).toBeNull();
  });
});

describe('mergeArchiveThreads', () => {
  test('takes the archive wholesale when nothing was touched locally', () => {
    const local = [thread('a', 1)];
    const archive = [thread('a', 1), thread('b', 2)];

    expect(mergeArchiveThreads(local, archive, new Set()).map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('keeps the local copy of a thread reconciled during the read', () => {
    const localA = thread('a', 1, ['new-reply']);
    const archive = [thread('a', 1), thread('b', 2)];

    const merged = mergeArchiveThreads([localA, thread('b', 2)], archive, new Set(['a']));

    // The archive predates the reply; taking it would drop that reply.
    expect(merged.find((t) => t.id === 'a')).toBe(localA);
    expect(merged.find((t) => t.id === 'a')?.comments).toHaveLength(2);
  });

  test('does not resurrect a thread deleted during the read', () => {
    // 'b' was dropped locally, so it is touched but absent from `local`.
    const merged = mergeArchiveThreads(
      [thread('a', 1)],
      [thread('a', 1), thread('b', 2)],
      new Set(['b']),
    );

    expect(merged.map((t) => t.id)).toEqual(['a']);
  });

  test('keeps a thread created locally that the archive has not seen', () => {
    const merged = mergeArchiveThreads(
      [thread('a', 1), thread('fresh', 3)],
      [thread('a', 1), thread('b', 2)],
      new Set(['fresh']),
    );

    expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'fresh']);
  });

  test('orders the result by root timestamp, as a full read arrives', () => {
    const merged = mergeArchiveThreads(
      [thread('late', 9)],
      [thread('mid', 5), thread('early', 1)],
      new Set(['late']),
    );

    expect(merged.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });

  test('an untouched local thread missing from the archive is dropped', () => {
    // It was resolved away by somebody else; the archive is authoritative.
    const merged = mergeArchiveThreads(
      [thread('a', 1), thread('gone', 2)],
      [thread('a', 1)],
      new Set(),
    );

    expect(merged.map((t) => t.id)).toEqual(['a']);
  });
});

describe('mergeOpenThreads', () => {
  test('replaces the open set and keeps everything settled', () => {
    const archived = thread('done-1', 1);
    const openWas = thread('open-1', 2);
    const openNow = thread('open-1', 2, ['new-reply']);

    const merged = mergeOpenThreads([archived, openWas], [openNow]);

    expect(merged.map((t) => t.id)).toEqual(['done-1', 'open-1']);
    // The re-read copy wins for the open thread; the archive is untouched.
    expect(merged.find((t) => t.id === 'open-1')).toBe(openNow);
    expect(merged.find((t) => t.id === 'done-1')).toBe(archived);
  });

  test('adds a thread opened elsewhere since the last read', () => {
    const merged = mergeOpenThreads([thread('a', 1)], [thread('a', 1), thread('b', 2)]);

    expect(merged.map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('keeps the archive even when the open read is empty', () => {
    // Resolving the last open thread: the read answers with nothing, and
    // dropping the settled work on that basis would empty the column.
    const merged = mergeOpenThreads([thread('done-1', 1), thread('done-2', 2)], []);

    expect(merged.map((t) => t.id)).toEqual(['done-1', 'done-2']);
  });

  test('orders by root timestamp, as a full read arrives', () => {
    const merged = mergeOpenThreads([thread('late', 9)], [thread('early', 1), thread('mid', 5)]);

    expect(merged.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });

  test('a thread appearing in both is not duplicated', () => {
    const merged = mergeOpenThreads([thread('x', 1), thread('y', 2)], [thread('x', 1)]);

    expect(merged.map((t) => t.id)).toEqual(['x', 'y']);
  });
});
