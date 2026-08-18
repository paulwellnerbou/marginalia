/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';

// bun's test environment has no DOM, and the modules under test reach for
// localStorage at import time via their dependencies — install the
// stand-in before the dynamic import below.
const store = new Map<string, string>();
// Set to make writes to a matching key throw, standing in for a browser
// with storage blocked or a full quota.
let rejectWritesTo: ((key: string) => boolean) | null = null;

function guardWrite(key: string): void {
  if (rejectWritesTo?.(key)) throw new DOMException('quota', 'QuotaExceededError');
}

(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    guardWrite(k);
    store.set(k, v);
  },
  removeItem: (k: string) => {
    guardWrite(k);
    store.delete(k);
  },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

// `clearSavedPassword` dispatches a CustomEvent; the keyring module
// listens on `window`. Neither exists here, and neither is what this
// test is about.
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

const { forgetDocumentLocally } = await import('./forget-doc.js');

const UID = 'doc-1';

function seed(): void {
  rejectWritesTo = null;
  store.clear();
  store.set(
    'marginalia.recentDocs',
    JSON.stringify([
      {
        uid: UID,
        title: 'Doomed',
        role: 'admin',
        password_protected: true,
        format: 'markdown',
        visited_at: 2,
        updated_at: 1,
        invite_token: 'tok',
      },
      {
        uid: 'doc-2',
        title: 'Survivor',
        role: 'reader',
        password_protected: false,
        format: 'markdown',
        visited_at: 1,
        updated_at: 1,
      },
    ]),
  );
  store.set(
    'marginalia.openTabs',
    JSON.stringify([
      { uid: UID, title: 'Doomed', format: 'markdown', invite_token: 'tok' },
      { uid: 'doc-2', title: 'Survivor', format: 'markdown' },
    ]),
  );
  store.set(`marginalia.invite.${UID}`, 'tok');
  store.set(`marginalia.password.${UID}`, 'hunter2');
  store.set(`marginalia.theme.${UID}`, 'sepia');
  // A second document's state, to prove the purge is scoped by uid.
  store.set('marginalia.invite.doc-2', 'tok-2');
  store.set('marginalia.password.doc-2', 'other');
  store.set('marginalia.theme.doc-2', 'default');
}

beforeEach(seed);

test('clears every per-document key for the deleted doc', () => {
  forgetDocumentLocally(UID);

  expect(store.get(`marginalia.invite.${UID}`)).toBeUndefined();
  expect(store.get(`marginalia.password.${UID}`)).toBeUndefined();
  expect(store.get(`marginalia.theme.${UID}`)).toBeUndefined();

  const recent = JSON.parse(store.get('marginalia.recentDocs') ?? '[]') as Array<{ uid: string }>;
  expect(recent.map((d) => d.uid)).toEqual(['doc-2']);

  const tabs = JSON.parse(store.get('marginalia.openTabs') ?? '[]') as Array<{ uid: string }>;
  expect(tabs.map((t) => t.uid)).toEqual(['doc-2']);
});

test('leaves other documents alone', () => {
  forgetDocumentLocally(UID);

  expect(store.get('marginalia.invite.doc-2')).toBe('tok-2');
  expect(store.get('marginalia.password.doc-2')).toBe('other');
  expect(store.get('marginalia.theme.doc-2')).toBe('default');
});

test('tombstones the uid so an in-flight keyring pull cannot restore it', () => {
  forgetDocumentLocally(UID);

  const tombstones = JSON.parse(
    store.get('marginalia.recentDocs.removed') ?? '[]',
  ) as unknown as string[];
  expect(tombstones).toContain(UID);
});

// The server has already destroyed the document by the time this runs.
// A store that refuses to write must not surface as a failed delete, and
// must not take the remaining stores down with it.
test('survives a store that throws, and still clears the rest', () => {
  rejectWritesTo = (key) => key === 'marginalia.recentDocs';
  const consoleError = console.error;
  console.error = () => {};

  try {
    expect(() => forgetDocumentLocally(UID)).not.toThrow();
  } finally {
    console.error = consoleError;
  }

  expect(store.get(`marginalia.invite.${UID}`)).toBeUndefined();
  expect(store.get(`marginalia.password.${UID}`)).toBeUndefined();
  expect(store.get(`marginalia.theme.${UID}`)).toBeUndefined();
});
