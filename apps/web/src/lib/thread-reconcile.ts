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

/**
 * Local open threads a fresh read of the open set no longer lists.
 *
 * Every mutation is broadcast to every subscriber except the client that
 * made it, and the client id is shared by every tab of one browser and by
 * every paired device. So an accept or a resolve made in another tab of
 * the same author reaches this one only through the next open read, where
 * the thread has simply gone missing. These are the threads to re-read one
 * by one, so an accepted proposal lands as resolved rather than lingering
 * as an open one that paints its whole block.
 */
export function staleOpenThreads(local: readonly Thread[], open: readonly Thread[]): Thread[] {
  const fresh = new Set(open.map((t) => t.id));
  return local.filter((t) => t.state === 'open' && !fresh.has(t.id));
}

/**
 * Fold a read of the open threads into the list already on screen.
 *
 * Reconciling after a mutation used to re-read every thread in the
 * document. On a long review that is overwhelmingly settled history:
 * one measured document answered `state=all` with 1871 threads and
 * 3.17 MB, of which 1837 threads and 99% of the bytes were resolved
 * work that cannot have changed. The same document answers `state=open`
 * with 34 threads and 32 KB.
 *
 * So the open set is re-read and the settled threads are kept: a
 * resolved thread pulled in on its own, by a deep link or a mutation,
 * cannot be in the open read and must survive it. A local *open* thread
 * the read no longer lists is the opposite case — it was settled or
 * deleted somewhere this client did not hear about (see
 * `staleOpenThreads`) — and keeping that copy would show a thread, and
 * paint a highlight, that no longer exists. It is dropped here and the
 * caller re-reads it.
 */
export function mergeOpenThreads(local: readonly Thread[], open: readonly Thread[]): Thread[] {
  const fresh = new Set(open.map((t) => t.id));
  const merged = [...open, ...local.filter((t) => !fresh.has(t.id) && t.state !== 'open')];
  merged.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
  return merged;
}
