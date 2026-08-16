import type { ThreadFilters } from './threadFilters.js';

/** Threads-tab ordering: appearance in the document, or latest activity first. */
export type ThreadSortMode = 'document' | 'latest';

const SORT_KEY = 'marginalia.threadListSort';
const STATUS_KEY = 'marginalia.threadListStatus';
const KIND_KEY = 'marginalia.threadListKind';
const REPLIES_KEY = 'marginalia.threadListReplies';
const FILTERS_OPEN_KEY = 'marginalia.threadListFiltersOpen';

/**
 * How the Threads tab opens before the reader has touched it: what
 * changed most recently first, resolved threads out of the way, and the
 * filter row expanded so those switches are visible rather than hidden
 * behind an icon. Nothing is narrowed to the viewer's own turn by
 * default — that hides threads nobody else has spoken in yet.
 */
export const DEFAULT_THREAD_SORT_MODE: ThreadSortMode = 'latest';
export const DEFAULT_THREAD_FILTERS: ThreadFilters = {
  status: 'unresolved',
  kind: 'all',
  replies: 'all',
};
export const DEFAULT_THREAD_FILTERS_OPEN = true;

export function loadThreadSortMode(): ThreadSortMode {
  const saved = localStorage.getItem(SORT_KEY);
  return saved === 'document' || saved === 'latest' ? saved : DEFAULT_THREAD_SORT_MODE;
}

export function saveThreadSortMode(mode: ThreadSortMode): void {
  localStorage.setItem(SORT_KEY, mode);
}

/** Each dimension falls back on its own, so one unreadable key can't reset the other. */
export function loadThreadFilters(): ThreadFilters {
  const status = localStorage.getItem(STATUS_KEY);
  const kind = localStorage.getItem(KIND_KEY);
  const replies = localStorage.getItem(REPLIES_KEY);
  return {
    status: status === 'all' || status === 'unresolved' ? status : DEFAULT_THREAD_FILTERS.status,
    kind: kind === 'all' || kind === 'proposals' ? kind : DEFAULT_THREAD_FILTERS.kind,
    replies:
      replies === 'all' || replies === 'unanswered' ? replies : DEFAULT_THREAD_FILTERS.replies,
  };
}

export function saveThreadFilters(filters: ThreadFilters): void {
  localStorage.setItem(STATUS_KEY, filters.status);
  localStorage.setItem(KIND_KEY, filters.kind);
  localStorage.setItem(REPLIES_KEY, filters.replies);
}

export function loadThreadFiltersOpen(): boolean {
  const saved = localStorage.getItem(FILTERS_OPEN_KEY);
  return saved === null ? DEFAULT_THREAD_FILTERS_OPEN : saved === 'true';
}

export function saveThreadFiltersOpen(open: boolean): void {
  localStorage.setItem(FILTERS_OPEN_KEY, String(open));
}
