import { isProposal, isResolved, type Thread } from '../../lib/api.js';

/** Threads-tab filters. See threadListPrefs for what they start out as. */
export type ThreadStatusFilter = 'all' | 'unresolved';
export type ThreadKindFilter = 'all' | 'proposals';

export interface ThreadFilters {
  status: ThreadStatusFilter;
  kind: ThreadKindFilter;
}

/** Filters nothing out — what "clear the filters" resets to. */
export const ALL_THREAD_FILTERS: ThreadFilters = { status: 'all', kind: 'all' };

/**
 * 'unresolved' keys off thread state, so an accepted or rejected
 * proposal drops out alongside a resolved comment.
 */
export function threadMatchesFilters(thread: Thread, filters: ThreadFilters): boolean {
  if (filters.status === 'unresolved' && isResolved(thread)) return false;
  if (filters.kind === 'proposals' && !isProposal(thread)) return false;
  return true;
}

/** Names the non-default filters so a collapsed filter row can still say what it is hiding. */
export function activeThreadFilterLabels(filters: ThreadFilters): string[] {
  const labels: string[] = [];
  if (filters.status === 'unresolved') labels.push('Unresolved');
  if (filters.kind === 'proposals') labels.push('Proposals');
  return labels;
}

export function isFilteringThreads(filters: ThreadFilters): boolean {
  return activeThreadFilterLabels(filters).length > 0;
}

/**
 * A pasted deep link ("…/d/<uid>#comment-<id>") or bare "#comment-<id>"
 * fragment means the id, not the literal text — the rest of such a URL
 * would match nothing.
 */
export function normalizeThreadSearch(raw: string): string {
  const query = raw.trim();
  const fragment = /#comment-([A-Za-z0-9_-]+)/.exec(query);
  return (fragment ? (fragment[1] as string) : query).toLowerCase();
}

/**
 * Case-insensitive substring match over everything a thread can be known
 * by: its id, each message's id (agents and copied links often name a
 * reply), author names, message bodies, and the anchored quote.
 */
export function threadMatchesSearch(thread: Thread, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const q = normalizedQuery;
  if (thread.id.toLowerCase().includes(q)) return true;
  if (thread.anchor.quote?.toLowerCase().includes(q)) return true;
  return thread.comments.some(
    (c) =>
      c.id.toLowerCase().includes(q) ||
      c.author.display_name.toLowerCase().includes(q) ||
      c.body.toLowerCase().includes(q),
  );
}
