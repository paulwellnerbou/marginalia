/**
 * Helpers for reconciling the thread column against realtime events and
 * the deferred archive read, without re-reading the whole document.
 *
 * A long-reviewed document carries far more settled threads than live
 * ones, so both paths are built around touching only what changed.
 */
import type { Thread } from './api.js';

/**
 * The thread a `comment.created` / `comment.updated` event belongs to.
 *
 * A root comment is its own thread; a reply names its thread through one
 * of the two parent columns. Null when the payload carries none of them,
 * which the caller should answer with a full reconcile rather than a
 * guess at which card to re-read.
 */
export function threadIdOfComment(comment: Record<string, unknown>): string | null {
  for (const key of ['parent_id', 'parent_proposal_id', 'id']) {
    const value = comment[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * Which loaded thread holds `commentId` — the thread's own id when it is
 * the root, otherwise the root of the thread the reply sits in. Null when
 * no loaded thread contains it, which on a delete means there is nothing
 * on screen to update.
 */
export function threadContainingComment(threads: Thread[], commentId: string): string | null {
  for (const thread of threads) {
    if (thread.id === commentId) return thread.id;
    if (thread.comments.some((c) => c.id === commentId)) return thread.id;
  }
  return null;
}

/**
 * Fold a just-arrived archive read into the threads already on screen.
 *
 * The archive answers a question asked before anything in `locallyTouched`
 * happened, so for those threads the local copy is the fresher one. Three
 * cases, and the reason each exists:
 *
 *  - touched and still present locally → keep the local copy; the archive
 *    would roll back a reply or a resolution the viewer already saw.
 *  - touched and absent locally → it was deleted mid-read; the archive
 *    still lists it, and taking that would resurrect it.
 *  - untouched → the archive is authoritative.
 *
 * Anything created locally mid-read is not in the archive at all and is
 * appended. The result is ordered by the root comment's timestamp, the
 * same order a full read arrives in.
 */
export function mergeArchiveThreads(
  local: Thread[],
  archive: Thread[],
  locallyTouched: ReadonlySet<string>,
): Thread[] {
  const fresher = new Map(local.filter((t) => locallyTouched.has(t.id)).map((t) => [t.id, t]));
  const merged = archive
    .filter((t) => fresher.has(t.id) || !locallyTouched.has(t.id))
    .map((t) => fresher.get(t.id) ?? t);

  const seen = new Set(merged.map((t) => t.id));
  for (const t of fresher.values()) if (!seen.has(t.id)) merged.push(t);

  merged.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
  return merged;
}
