import { isBookmark, type Thread } from '../../lib/api.js';
import { isOwnBookmark } from '../../lib/bookmark-markers.js';
import { readDocViewPref, writeDocViewPref } from '../../lib/doc-view-prefs.js';

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

export function loadBookmarkFilter(docUid: string): BookmarkFilter {
  const saved = readDocViewPref(docUid, 'bookmarkListFilter');
  return saved === 'shared' || saved === 'mine' ? saved : 'all';
}

export function saveBookmarkFilter(docUid: string, filter: BookmarkFilter): void {
  writeDocViewPref(docUid, 'bookmarkListFilter', filter);
}
