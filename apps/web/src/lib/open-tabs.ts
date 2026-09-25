/**
 * The document tabs in the app bar — an explicit open/close set, kept in
 * localStorage so the strip survives a reload.
 *
 * Deliberately not derived from `recent-docs`. Recents are a history:
 * everything this browser ever opened, fifty entries deep, ordered by
 * when you last looked at it. Tabs are a working set the reader curates
 * — opening a document adds one, the ✕ takes it away, and closing a tab
 * never forgets the document.
 */

import { useEffect, useState } from 'react';
import type { DocumentFormat } from './api.js';

const KEY = 'marginalia.openTabs';
const CHANGE_EVENT = 'marginalia:open-tabs';
/** Past this the strip stops being scannable, and the least recently
 *  opened tab gives way. Recents still hold what falls off. */
const MAX = 10;

export interface OpenTab {
  uid: string;
  title: string;
  format: DocumentFormat;
  /** Invite token to re-open with, absent for publicly readable docs. */
  invite_token?: string;
}

export function loadOpenTabs(): OpenTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(coerceTab);
  } catch {
    return [];
  }
}

/**
 * Record a document as open, or refresh the label of a tab it already
 * has. A revisit updates in place rather than moving to the end: a strip
 * that reorders itself every time you come back to a tab is one you can
 * never learn the shape of.
 */
export function openTab(tab: OpenTab): OpenTab[] {
  const list = loadOpenTabs();
  const at = list.findIndex((t) => t.uid === tab.uid);
  if (at >= 0) list[at] = tab;
  else list.push(tab);
  // The tab just opened sits last, so trimming from the front can never
  // drop the one the reader is looking at.
  return save(list.slice(-MAX));
}

/** Swap in a rotated invite token, for the reason `updateRecentDocToken` gives. */
export function updateOpenTabToken(uid: string, token: string): void {
  const list = loadOpenTabs();
  const tab = list.find((t) => t.uid === uid);
  if (!tab || tab.invite_token === token) return;
  tab.invite_token = token;
  save(list);
}

export function closeTab(uid: string): OpenTab[] {
  return save(loadOpenTabs().filter((t) => t.uid !== uid));
}

/** Empty the strip, handing back what it held so the caller can offer
 *  to put it back. */
export function closeAllTabs(): OpenTab[] {
  const closed = loadOpenTabs();
  save([]);
  return closed;
}

/**
 * Undo `closeAllTabs`. Tabs opened in the meantime (here or in another
 * browser tab) are kept, after the restored ones and in their fresher
 * form, so the undo can't take back a later open.
 */
export function restoreTabs(tabs: OpenTab[]): OpenTab[] {
  const current = loadOpenTabs();
  const fresh = new Map(current.map((t) => [t.uid, t]));
  const restored = new Set(tabs.map((t) => t.uid));
  return save(
    [
      ...tabs.map((t) => fresh.get(t.uid) ?? t),
      ...current.filter((t) => !restored.has(t.uid)),
    ].slice(-MAX),
  );
}

/**
 * Where to go when the open document's own tab is closed: the tab to its
 * right, or its left when it was the last one. Null leaves the caller to
 * fall back to the home page.
 */
export function neighbourOf(tabs: OpenTab[], uid: string): OpenTab | null {
  const at = tabs.findIndex((t) => t.uid === uid);
  if (at < 0) return null;
  return tabs[at + 1] ?? tabs[at - 1] ?? null;
}

/** Carry the invite token in the URL, as the recent-doc cards do — the
 *  copy in localStorage may have been cleared since. */
export function tabUrl(tab: OpenTab): string {
  return tab.invite_token ? `/d/${tab.uid}/${tab.invite_token}` : `/d/${tab.uid}`;
}

/** Subscribe to strip changes from this tab (`openTab`/`closeTab`) and
 *  from other browser tabs (the native `storage` event). */
export function onOpenTabsChange(fn: (tabs: OpenTab[]) => void): () => void {
  const inApp = (e: Event) => fn((e as CustomEvent<OpenTab[]>).detail);
  const crossTab = (e: StorageEvent) => {
    if (e.key === KEY) fn(loadOpenTabs());
  };
  window.addEventListener(CHANGE_EVENT, inApp);
  window.addEventListener('storage', crossTab);
  return () => {
    window.removeEventListener(CHANGE_EVENT, inApp);
    window.removeEventListener('storage', crossTab);
  };
}

/** Reactive view of the strip, kept in sync with opens and closes made
 *  anywhere in the app. */
export function useOpenTabs(): OpenTab[] {
  const [tabs, setTabs] = useState<OpenTab[]>(() => loadOpenTabs());
  useEffect(() => onOpenTabsChange(setTabs), []);
  return tabs;
}

function save(tabs: OpenTab[]): OpenTab[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    /* quota exceeded — best-effort */
  }
  // StorageEvent only fires in *other* browser tabs, never the one that
  // did the write, so the in-app channel is what updates this app bar.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: tabs }));
  return tabs;
}

const VALID_FORMATS = new Set<DocumentFormat>(['markdown', 'asciidoc']);

function coerceTab(v: unknown): OpenTab[] {
  if (!v || typeof v !== 'object') return [];
  const t = v as Record<string, unknown>;
  if (typeof t.uid !== 'string' || typeof t.title !== 'string') return [];
  return [
    {
      uid: t.uid,
      title: t.title,
      format: VALID_FORMATS.has(t.format as DocumentFormat)
        ? (t.format as DocumentFormat)
        : 'markdown',
      ...(typeof t.invite_token === 'string' ? { invite_token: t.invite_token } : {}),
    },
  ];
}
