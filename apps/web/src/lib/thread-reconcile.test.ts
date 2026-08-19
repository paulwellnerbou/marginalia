/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import type { Thread } from './api.js';
import {
  mergeArchiveThreads,
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
