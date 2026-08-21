/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import type { Thread } from './api.js';
import { partitionPendingMentions } from './pending-mentions.js';

/**
 * Opening a document reads only the open threads, so a mention that landed
 * in a resolved one has no comment to name. The server has already cleared
 * it by then, so anything dropped here is a notification the reader never
 * gets — these cases are what force the archive to be fetched instead.
 */
function thread(id: string, commentIds: string[]): Thread {
  return {
    comments: commentIds.map((cid) => ({
      id: cid,
      body: `body of ${cid}`,
      author: { client_id: 'c1', display_name: 'Ruth' },
    })),
  } as unknown as Thread;
}

describe('partitionPendingMentions', () => {
  test('delivers the mentions these threads can describe', () => {
    const threads = [thread('t1', ['t1', 'r1']), thread('t2', ['t2'])];

    const { deliverable, undelivered } = partitionPendingMentions(threads, ['r1', 't2']);

    expect(deliverable.map((c) => c.id)).toEqual(['r1', 't2']);
    expect(undelivered).toEqual([]);
  });

  test('reports the ones no loaded thread contains', () => {
    // The regression this guards: with only the open threads loaded, a
    // mention inside a settled one used to be silently discarded.
    const threads = [thread('open-1', ['open-1'])];

    const { deliverable, undelivered } = partitionPendingMentions(threads, [
      'open-1',
      'in-resolved',
    ]);

    expect(deliverable.map((c) => c.id)).toEqual(['open-1']);
    expect(undelivered).toEqual(['in-resolved']);
  });

  test('finds mentions in replies, not just openers', () => {
    const threads = [thread('t1', ['t1', 'reply-a', 'reply-b'])];

    expect(partitionPendingMentions(threads, ['reply-b']).deliverable.map((c) => c.id)).toEqual([
      'reply-b',
    ]);
  });

  test('nothing pending does no work', () => {
    expect(partitionPendingMentions([thread('t1', ['t1'])], [])).toEqual({
      deliverable: [],
      undelivered: [],
    });
  });

  test('an empty thread list leaves every mention outstanding', () => {
    expect(partitionPendingMentions([], ['a', 'b']).undelivered).toEqual(['a', 'b']);
  });
});
