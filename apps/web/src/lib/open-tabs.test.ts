/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import {
  closeAllTabs,
  closeTab,
  loadOpenTabs,
  neighbourOf,
  type OpenTab,
  openTab,
  restoreTabs,
  tabUrl,
  updateOpenTabToken,
} from './open-tabs.js';

const KEY = 'marginalia.openTabs';
const store = new Map<string, string>();

// bun's test environment has no DOM. The module touches localStorage, and
// announces every write on a window event — stand-ins for both are the
// whole dependency.
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as { CustomEvent?: unknown }).CustomEvent = class {
  detail: unknown;
  constructor(_type: string, init?: { detail?: unknown }) {
    this.detail = init?.detail;
  }
};

function tab(over: Partial<OpenTab> = {}): OpenTab {
  return { uid: 'doc-1', title: 'One', format: 'markdown', ...over };
}

beforeEach(() => {
  store.clear();
});

test('opening documents appends them left to right', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  expect(loadOpenTabs().map((t) => t.uid)).toEqual(['doc-1', 'doc-2']);
});

test('re-opening refreshes the label without moving the tab', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  openTab(tab({ title: 'One, renamed', format: 'asciidoc' }));

  const tabs = loadOpenTabs();
  expect(tabs.map((t) => t.uid)).toEqual(['doc-1', 'doc-2']);
  expect(tabs[0]).toEqual({ uid: 'doc-1', title: 'One, renamed', format: 'asciidoc' });
});

test('the strip is capped, and the document just opened is never what falls off', () => {
  for (let i = 0; i < 14; i++) openTab(tab({ uid: `doc-${i}`, title: `Doc ${i}` }));

  const tabs = loadOpenTabs();
  expect(tabs).toHaveLength(10);
  expect(tabs[0]?.uid).toBe('doc-4');
  expect(tabs.at(-1)?.uid).toBe('doc-13');
});

test('closing removes only that tab', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  expect(closeTab('doc-1').map((t) => t.uid)).toEqual(['doc-2']);
  expect(loadOpenTabs().map((t) => t.uid)).toEqual(['doc-2']);
});

test('closing all empties the strip and hands back what it held', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  expect(closeAllTabs().map((t) => t.uid)).toEqual(['doc-1', 'doc-2']);
  expect(loadOpenTabs()).toEqual([]);
});

test('undoing close-all puts the tabs back in their order', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  restoreTabs(closeAllTabs());
  expect(loadOpenTabs().map((t) => t.uid)).toEqual(['doc-1', 'doc-2']);
});

test('undoing close-all keeps what was opened since, after the restored tabs', () => {
  openTab(tab());
  openTab(tab({ uid: 'doc-2', title: 'Two' }));
  const closed = closeAllTabs();
  openTab(tab({ uid: 'doc-3', title: 'Three' }));
  openTab(tab({ uid: 'doc-2', title: 'Two, renamed' }));

  restoreTabs(closed);
  expect(loadOpenTabs().map((t) => [t.uid, t.title])).toEqual([
    ['doc-1', 'One'],
    ['doc-2', 'Two, renamed'],
    ['doc-3', 'Three'],
  ]);
});

test('undoing close-all stays under the cap, dropping from the front', () => {
  for (let i = 0; i < 10; i++) openTab(tab({ uid: `doc-${i}`, title: `Doc ${i}` }));
  const closed = closeAllTabs();
  openTab(tab({ uid: 'new', title: 'New' }));

  const tabs = restoreTabs(closed);
  expect(tabs).toHaveLength(10);
  expect(tabs[0]?.uid).toBe('doc-1');
  expect(tabs.at(-1)?.uid).toBe('new');
});

test('the neighbour of a closed tab is its right, then its left', () => {
  const tabs = [tab(), tab({ uid: 'doc-2' }), tab({ uid: 'doc-3' })];
  expect(neighbourOf(tabs, 'doc-1')?.uid).toBe('doc-2');
  expect(neighbourOf(tabs, 'doc-2')?.uid).toBe('doc-3');
  expect(neighbourOf(tabs, 'doc-3')?.uid).toBe('doc-2');
  expect(neighbourOf([tab()], 'doc-1')).toBeNull();
  expect(neighbourOf(tabs, 'doc-absent')).toBeNull();
});

test('an invite token rides along in the tab URL', () => {
  expect(tabUrl(tab())).toBe('/d/doc-1');
  expect(tabUrl(tab({ invite_token: 'tok' }))).toBe('/d/doc-1/tok');
});

test('garbage entries are dropped rather than rendered as tabs', () => {
  store.set(
    KEY,
    JSON.stringify([
      { uid: 'doc-1', title: 'One' },
      { uid: 42 },
      null,
      'nope',
      { title: 'no uid' },
    ]),
  );
  // A missing format is the one legacy shape worth keeping: markdown is
  // what every pre-AsciiDoc document was.
  expect(loadOpenTabs()).toEqual([{ uid: 'doc-1', title: 'One', format: 'markdown' }]);
});

test('a corrupt strip reads as empty instead of throwing', () => {
  store.set(KEY, '{not json');
  expect(loadOpenTabs()).toEqual([]);
});

test('a rotated token replaces the one a tab would re-open with', () => {
  openTab(tab({ invite_token: 'old' }));
  updateOpenTabToken('doc-1', 'new');
  updateOpenTabToken('not-open', 'new');
  expect(loadOpenTabs().map(tabUrl)).toEqual(['/d/doc-1/new']);
});
