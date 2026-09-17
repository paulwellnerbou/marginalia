/**
 * Thread bookmarks — the toggle on a thread card. The server keeps them per
 * reader, so they follow the reader to every paired device and to the app;
 * the document layout holds the current set and hands it to the cards.
 *
 * Before that, each browser kept its own set in localStorage. Whatever a
 * browser still holds there is uploaded once and then dropped, which is all
 * the storage helpers below exist for.
 */

import { createContext, useContext } from 'react';

const LEGACY_KEY = 'marginalia.bookmarkedThreads';

/** uid → the thread ids bookmarked in that document. */
type LegacyStore = Record<string, string[]>;

function loadLegacyStore(): LegacyStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: LegacyStore = {};
    for (const [uid, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) store[uid] = ids.filter((id): id is string => typeof id === 'string');
    }
    return store;
  } catch {
    return {};
  }
}

/** The threads this browser bookmarked in `uid` while bookmarks were kept locally. */
export function legacyBookmarkedThreadIds(uid: string): string[] {
  return loadLegacyStore()[uid] ?? [];
}

/** Drop `uid`'s locally kept bookmarks once the server has them. */
export function forgetLegacyBookmarkedThreadIds(uid: string): void {
  const store = loadLegacyStore();
  if (!(uid in store)) return;
  delete store[uid];
  try {
    if (Object.keys(store).length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(store));
  } catch {
    /* best-effort: a later visit uploads the same ids again, harmlessly */
  }
}

/**
 * Per-card bookmark control, provided by the document layout and read by
 * every thread card — in the right-pane list, the margin column and the
 * floating layer alike — so the toggle behaves the same wherever a card
 * is drawn, without threading two props through three render paths.
 */
export interface BookmarkControls {
  isBookmarked: (threadId: string) => boolean;
  toggle: (threadId: string) => void;
}

const BookmarkControlsContext = createContext<BookmarkControls | null>(null);

export const BookmarkControlsProvider = BookmarkControlsContext.Provider;

/** Null outside a provider (e.g. a card rendered in isolation) — the toggle then hides. */
export function useBookmarkControls(): BookmarkControls | null {
  return useContext(BookmarkControlsContext);
}
