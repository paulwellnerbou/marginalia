import { isProposal, isResolved, type Thread } from '../../lib/api.js';

/** Threads-tab filters. Both dimensions default to `'all'`. */
export type ThreadStatusFilter = 'all' | 'unresolved';
export type ThreadKindFilter = 'all' | 'proposals';

export interface ThreadFilters {
  status: ThreadStatusFilter;
  kind: ThreadKindFilter;
}

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
