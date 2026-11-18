import { isBookmark, type Thread } from '../../lib/api.js';
import { isOwnBookmark } from '../../lib/bookmark-markers.js';
import { readDocViewPref, writeDocViewPref } from '../../lib/doc-view-prefs.js';
import { buildThreadListCards } from './threadListCards.js';

/** Bookmarks-tab narrowing: everything, what everyone sees, or the viewer's own. */
export type BookmarkFilter = 'all' | 'shared' | 'mine';

/**
 * A starred comment thread is a private mark the viewer set, whoever wrote
 * the thread — so it is theirs and never shared. A passage bookmark is
 * shared unless hidden; someone else's reaches the viewer only when shared.
 */
export function matchesBookmarkFilter(thread: Thread, filter: BookmarkFilter): boolean {
  if (filter === 'all') return true;
  if (!isBookmark(thread)) return filter === 'mine';
  return filter === 'mine' ? isOwnBookmark(thread) : thread.comments[0].hidden !== true;
}

/**
 * Whether the filter would tell anything apart in `threads`: a list that is
 * all private, all shared, or all the viewer's gets the same cards from two
 * of the three choices and an empty list from the third.
 */
export function bookmarkFilterSplits(threads: readonly Thread[]): boolean {
  let shared = false;
  let notShared = false;
  let mine = false;
  let notMine = false;
  for (const t of threads) {
    if (matchesBookmarkFilter(t, 'shared')) shared = true;
    else notShared = true;
    if (matchesBookmarkFilter(t, 'mine')) mine = true;
    else notMine = true;
    if ((shared && notShared) || (mine && notMine)) return true;
  }
  return false;
}

/**
 * The cards the Bookmarks tab lists under `filter`, counted as it counts
 * them — a proposal nested in a starred comment is part of that card — so
 * the tab's badge agrees with the tab while it is closed.
 */
export function countBookmarkCards(threads: Thread[], filter: BookmarkFilter): number {
  let count = 0;
  for (const card of buildThreadListCards(threads).cards) {
    if (matchesBookmarkFilter(card.thread, filter)) count++;
  }
  return count;
}

/** Anything unrecognised — junk in storage, a value from a newer build — shows everything. */
export function parseBookmarkFilter(value: string | null): BookmarkFilter {
  return value === 'shared' || value === 'mine' ? value : 'all';
}

export function loadBookmarkFilter(docUid: string): BookmarkFilter {
  return parseBookmarkFilter(readDocViewPref(docUid, 'bookmarkListFilter'));
}

export function saveBookmarkFilter(docUid: string, filter: BookmarkFilter): void {
  writeDocViewPref(docUid, 'bookmarkListFilter', filter);
}
