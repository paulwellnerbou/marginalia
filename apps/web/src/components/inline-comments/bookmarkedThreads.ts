/**
 * Bookmarked threads — a per-document set of thread ids the reader has
 * starred, kept in localStorage so the Bookmarks tab survives a reload.
 *
 * Scoped by document uid, unlike the threads-tab sort/filter prefs in
 * threadListPrefs (which are global to the browser): a bookmark names one
 * thread, and a thread belongs to one document. The storage shape and the
 * in-app change channel follow open-tabs — the one other place that keeps
 * a reader-curated set in localStorage and needs the live view to react.
 */

import { createContext, useContext, useEffect, useState } from 'react';

const KEY = 'marginalia.bookmarkedThreads';
const CHANGE_EVENT = 'marginalia:bookmarked-threads';

/** uid → the thread ids bookmarked in that document. */
type Store = Record<string, string[]>;

function loadStore(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: Store = {};
    for (const [uid, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) store[uid] = ids.filter((id): id is string => typeof id === 'string');
    }
    return store;
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota exceeded — best-effort, matches open-tabs */
  }
  // The native `storage` event fires only in *other* tabs, so this in-app
  // channel is what refreshes the current one after a toggle.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function loadBookmarkedThreadIds(uid: string): ReadonlySet<string> {
  return new Set(loadStore()[uid] ?? []);
}

/** Flip a thread's bookmark and persist. Returns the document's new set. */
export function toggleBookmarkedThread(uid: string, threadId: string): ReadonlySet<string> {
  const store = loadStore();
  const ids = new Set(store[uid] ?? []);
  if (ids.has(threadId)) ids.delete(threadId);
  else ids.add(threadId);
  // Drop the key entirely once its last bookmark is gone, so an emptied
  // document leaves nothing behind in storage.
  if (ids.size === 0) delete store[uid];
  else store[uid] = [...ids];
  saveStore(store);
  return ids;
}

/** Subscribe to changes for one document — this tab's toggles and other tabs' writes. */
export function onBookmarkedThreadsChange(
  uid: string,
  fn: (ids: ReadonlySet<string>) => void,
): () => void {
  const inApp = () => fn(loadBookmarkedThreadIds(uid));
  const crossTab = (e: StorageEvent) => {
    if (e.key === KEY) fn(loadBookmarkedThreadIds(uid));
  };
  window.addEventListener(CHANGE_EVENT, inApp);
  window.addEventListener('storage', crossTab);
  return () => {
    window.removeEventListener(CHANGE_EVENT, inApp);
    window.removeEventListener('storage', crossTab);
  };
}

/** Reactive view of one document's bookmarks, in sync with toggles made anywhere. */
export function useBookmarkedThreads(uid: string): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => loadBookmarkedThreadIds(uid));
  useEffect(() => {
    setIds(loadBookmarkedThreadIds(uid));
    return onBookmarkedThreadsChange(uid, setIds);
  }, [uid]);
  return ids;
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
