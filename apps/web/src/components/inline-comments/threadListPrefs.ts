import { readDocViewPref, writeDocViewPref } from '../../lib/doc-view-prefs.js';
import type { ThreadFilters } from './threadFilters.js';

/** Threads-tab ordering: appearance in the document, or latest activity first. */
export type ThreadSortMode = 'document' | 'latest';

/**
 * How the Threads tab opens before the reader has touched it: what
 * changed most recently first, and resolved threads out of the way.
 * Nothing is narrowed to the viewer's own turn by default — that hides
 * threads nobody else has spoken in yet.
 */
export const DEFAULT_THREAD_SORT_MODE: ThreadSortMode = 'latest';
export const DEFAULT_THREAD_FILTERS: ThreadFilters = {
  status: 'unresolved',
  kind: 'all',
  replies: 'all',
};

export function loadThreadSortMode(docUid: string): ThreadSortMode {
  const saved = readDocViewPref(docUid, 'threadListSort');
  return saved === 'document' || saved === 'latest' ? saved : DEFAULT_THREAD_SORT_MODE;
}

export function saveThreadSortMode(docUid: string, mode: ThreadSortMode): void {
  writeDocViewPref(docUid, 'threadListSort', mode);
}

/** Each dimension falls back on its own, so one unreadable key can't reset the other. */
export function loadThreadFilters(docUid: string): ThreadFilters {
  const status = readDocViewPref(docUid, 'threadListStatus');
  const kind = readDocViewPref(docUid, 'threadListKind');
  const replies = readDocViewPref(docUid, 'threadListReplies');
  return {
    status: status === 'all' || status === 'unresolved' ? status : DEFAULT_THREAD_FILTERS.status,
    kind: kind === 'all' || kind === 'proposals' ? kind : DEFAULT_THREAD_FILTERS.kind,
    replies:
      replies === 'all' || replies === 'unanswered' ? replies : DEFAULT_THREAD_FILTERS.replies,
  };
}

export function saveThreadFilters(docUid: string, filters: ThreadFilters): void {
  writeDocViewPref(docUid, 'threadListStatus', filters.status);
  writeDocViewPref(docUid, 'threadListKind', filters.kind);
  writeDocViewPref(docUid, 'threadListReplies', filters.replies);
}
