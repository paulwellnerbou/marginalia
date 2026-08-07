/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import type { KeyringDocEntry } from './api.js';
import { loadRecentDocs, mergeKeyringDocs, type RecentDoc, recordVisit } from './recent-docs.js';

const KEY = 'marginalia.recentDocs';

// bun's test environment has no DOM. The module only ever touches
// localStorage, so a Map-backed stand-in is the whole dependency.
function installLocalStorage(): void {
  const store = new Map<string, string>();
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
}

function entry(over: Partial<KeyringDocEntry> = {}): KeyringDocEntry {
  return {
    doc_uid: 'doc-1',
    invite_token: 'token-server',
    title: 'Server title',
    role: 'admin',
    format: 'markdown',
    password_protected: false,
    updated_at: 1_000,
    added_at: 500,
    cover: null,
    ...over,
  };
}

function local(over: Partial<RecentDoc> = {}): RecentDoc {
  return {
    uid: 'doc-1',
    title: 'Local title',
    role: 'reader',
    password_protected: false,
    format: 'markdown',
    visited_at: 9_000,
    updated_at: 800,
    invite_token: 'token-local',
    ...over,
  };
}

beforeEach(() => {
  installLocalStorage();
  localStorage.clear();
});

test('adds documents this browser has never seen', () => {
  const merged = mergeKeyringDocs([entry()]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.uid).toBe('doc-1');
  expect(merged[0]?.invite_token).toBe('token-server');
  // Never opened here, so it sorts by when the ring gained it.
  expect(merged[0]?.visited_at).toBe(500);
});

test('the synced token wins, so a rotation on one device reaches the others', () => {
  recordVisit(local());
  const merged = mergeKeyringDocs([entry({ invite_token: 'token-rotated' })]);
  expect(merged[0]?.invite_token).toBe('token-rotated');
});

test('this browser keeps its own visit time, so syncing does not reorder the list', () => {
  recordVisit(local({ uid: 'a', visited_at: 5_000 }));
  recordVisit(local({ uid: 'b', visited_at: 9_000 }));

  const merged = mergeKeyringDocs([
    entry({ doc_uid: 'a', added_at: 100 }),
    entry({ doc_uid: 'b', added_at: 100 }),
  ]);

  expect(merged.map((d) => d.uid)).toEqual(['b', 'a']);
  expect(merged.find((d) => d.uid === 'b')?.visited_at).toBe(9_000);
});

test('a revoked invite keeps the role this browser last saw', () => {
  recordVisit(local({ role: 'editor' }));
  const merged = mergeKeyringDocs([entry({ role: null })]);
  expect(merged[0]?.role).toBe('editor');
});

test('an unknown document with no role falls back to reader', () => {
  const merged = mergeKeyringDocs([entry({ role: null })]);
  expect(merged[0]?.role).toBe('reader');
});

test('a title the server does not have falls back to the local one', () => {
  recordVisit(local({ title: 'My notes' }));
  const merged = mergeKeyringDocs([entry({ title: null })]);
  expect(merged[0]?.title).toBe('My notes');
});

test('covers come from the server, so one added elsewhere shows up before the next visit', () => {
  recordVisit(local());
  const merged = mergeKeyringDocs([
    entry({ cover: { ref_name: 'cover.png', asset_id: 'sha', mime: 'image/png' } }),
  ]);
  expect(merged[0]?.cover?.ref_name).toBe('cover.png');
});

test('documents held only locally survive a sync', () => {
  recordVisit(local({ uid: 'only-here', visited_at: 20_000 }));
  const merged = mergeKeyringDocs([entry({ doc_uid: 'from-ring' })]);
  expect(merged.map((d) => d.uid).sort()).toEqual(['from-ring', 'only-here']);
});

test('the merged list is what gets persisted', () => {
  mergeKeyringDocs([entry()]);
  expect(loadRecentDocs().map((d) => d.uid)).toEqual(['doc-1']);
  expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toHaveLength(1);
});

test('updated_at takes whichever side is fresher', () => {
  recordVisit(local({ updated_at: 5_000 }));
  expect(mergeKeyringDocs([entry({ updated_at: 1_000 })])[0]?.updated_at).toBe(5_000);
  expect(mergeKeyringDocs([entry({ updated_at: 9_000 })])[0]?.updated_at).toBe(9_000);
});
