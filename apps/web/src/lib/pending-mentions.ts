import type { Comment, Thread } from './api.js';

/**
 * Split pending mentions into the ones these threads can describe and the
 * ones they cannot.
 *
 * The server clears a pending mention the moment it reports it, so an id
 * that goes unmatched is a notification the reader never gets. A client
 * holding only the open threads will miss every mention that landed in a
 * settled one, which is why the leftovers are returned rather than
 * dropped: the caller fetches the archive and asks again.
 */
export function partitionPendingMentions(
  threads: readonly Thread[],
  pendingMentionIds: readonly string[],
): { deliverable: Comment[]; undelivered: string[] } {
  if (pendingMentionIds.length === 0) return { deliverable: [], undelivered: [] };
  const byId = new Map<string, Comment>();
  for (const t of threads) {
    for (const c of t.comments) byId.set(c.id, c);
  }
  const deliverable: Comment[] = [];
  const undelivered: string[] = [];
  for (const id of pendingMentionIds) {
    const node = byId.get(id);
    if (node) deliverable.push(node);
    else undelivered.push(id);
  }
  return { deliverable, undelivered };
}
