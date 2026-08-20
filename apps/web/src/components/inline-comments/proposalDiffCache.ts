import type { ProposalDiff, ProposalStatus } from '../../lib/api.js';

/**
 * An open proposal's text can change in place, making a displayed diff
 * stale. Closed proposal payloads deliberately omit that text, though, so
 * their string -> null transition must not evict the diff just before the
 * dialog closes.
 */
export function proposalDiffNeedsRefresh(
  status: ProposalStatus,
  previousText: string | null,
  currentText: string | null,
): boolean {
  return status === 'open' && previousText !== currentText;
}

/**
 * Diffs already fetched, kept across the card unmounting.
 *
 * The card holds its diff in component state, which was enough while
 * every thread card stayed mounted. Now that the lists render only what
 * is near the viewport, a card that scrolls out of the window is
 * destroyed and takes its diff with it — so re-opening the same proposal
 * fetched the whole payload again. One measured session pulled the same
 * diff four times in ninety seconds.
 *
 * Entries are validated against the proposal's current text by the same
 * rule the card uses in-place, so an edited proposal never shows the
 * version it replaced.
 */
interface Entry {
  /** The proposal text this diff was fetched for; null once closed. */
  proposedText: string | null;
  diff: ProposalDiff;
}

/**
 * Documents' worth of proposals to remember. A diff is now a window
 * around one block rather than two whole documents, so these are small;
 * the cap is here to bound a long review session, not the payloads.
 */
const MAX_ENTRIES = 32;

/** Insertion order is the LRU order; a hit re-inserts to move to the back. */
const entries = new Map<string, Entry>();

function keyOf(uid: string, threadId: string): string {
  return `${uid}|${threadId}`;
}

/**
 * The cached diff for this proposal, or null if there is nothing usable.
 *
 * These are the plain diffs, the only kind anything fetches. The endpoint
 * also has a `?mergeable=1` variant that answers with a merge status
 * attached; if something starts asking for that, it needs its own key
 * rather than this one, which would hand it a diff with the field absent.
 */
export function readCachedProposalDiff(
  uid: string,
  threadId: string,
  status: ProposalStatus,
  proposedText: string | null,
): ProposalDiff | null {
  const key = keyOf(uid, threadId);
  const hit = entries.get(key);
  if (!hit) return null;
  if (proposalDiffNeedsRefresh(status, hit.proposedText, proposedText)) {
    entries.delete(key);
    return null;
  }
  // Re-insert to move this entry to the back of the LRU order.
  entries.delete(key);
  entries.set(key, hit);
  return hit.diff;
}

export function writeCachedProposalDiff(
  uid: string,
  threadId: string,
  proposedText: string | null,
  diff: ProposalDiff,
): void {
  const key = keyOf(uid, threadId);
  entries.delete(key);
  entries.set(key, { proposedText, diff });
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** Test seam — the cache is module-global and would leak between cases. */
export function resetProposalDiffCache(): void {
  entries.clear();
}
