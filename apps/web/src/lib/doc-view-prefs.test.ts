/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import {
  docViewKey,
  docViewUidOf,
  forgetDocViewPrefs,
  persistStep,
  readDocViewPref,
  writeDocViewPref,
} from './doc-view-prefs.js';

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => store.clear());

test('a setting changed on one document leaves the others alone', () => {
  writeDocViewPref('a', 'textZoom', '130', storage);
  expect(readDocViewPref('a', 'textZoom', storage)).toBe('130');
  expect(readDocViewPref('b', 'textZoom', storage)).toBeNull();
});

test('a document without settings of its own reads the old per-browser value', () => {
  store.set('marginalia.textZoom', '140');
  store.set('marginalia.readingMode', 'paged');
  expect(readDocViewPref('a', 'textZoom', storage)).toBe('140');
  expect(readDocViewPref('a', 'readingMode', storage)).toBe('paged');
});

test('the first change copies the old values in, and the old keys stay untouched', () => {
  store.set('marginalia.textZoom', '140');
  store.set('marginalia.readingMode', 'paged');
  writeDocViewPref('a', 'textZoom', '110', storage);

  expect(readDocViewPref('a', 'textZoom', storage)).toBe('110');
  expect(readDocViewPref('a', 'readingMode', storage)).toBe('paged');
  expect(store.get('marginalia.textZoom')).toBe('140');
  expect(readDocViewPref('b', 'textZoom', storage)).toBe('140');
});

test('clearing a setting does not bring the old per-browser value back', () => {
  store.set('marginalia.commentsDisplayMode', 'floating');
  writeDocViewPref('a', 'commentsDisplayMode', null, storage);
  expect(readDocViewPref('a', 'commentsDisplayMode', storage)).toBeNull();
});

test('a damaged entry reads as empty rather than falling back', () => {
  store.set('marginalia.textZoom', '140');
  store.set(docViewKey('a'), 'not json');
  expect(readDocViewPref('a', 'textZoom', storage)).toBeNull();
  writeDocViewPref('a', 'maxWidth', '80', storage);
  expect(JSON.parse(store.get(docViewKey('a')) ?? '')).toEqual({ maxWidth: '80' });
});

test('forgetting a document drops its entry only', () => {
  writeDocViewPref('a', 'textZoom', '130', storage);
  writeDocViewPref('b', 'textZoom', '90', storage);
  forgetDocViewPrefs('a', storage);
  expect(store.has(docViewKey('a'))).toBe(false);
  expect(readDocViewPref('b', 'textZoom', storage)).toBe('90');
});

test('docViewUidOf recognises only view entries', () => {
  expect(docViewUidOf(docViewKey('abc'))).toBe('abc');
  expect(docViewUidOf('marginalia.theme.abc')).toBeNull();
  expect(docViewUidOf(null)).toBeNull();
});

test('opening a document stores nothing; a change for it does', () => {
  const opened = { uid: 'a', value: '100' };
  expect(persistStep(opened, 'a', '100').write).toBe(false);
  const changed = persistStep(opened, 'a', '110');
  expect(changed.write).toBe(true);
  // Back to where it started is a change too, not a no-op.
  expect(persistStep(changed.next, 'a', '100').write).toBe(true);
});

test("switching documents in place does not write the new one's own value back", () => {
  const step = persistStep({ uid: 'a', value: '130' }, 'b', '100');
  expect(step.write).toBe(false);
  expect(step.next).toEqual({ uid: 'b', value: '100' });
  expect(persistStep(step.next, 'b', '105').write).toBe(true);
});

test('undefined leaves the stored value, so returning to it writes nothing', () => {
  const opened = { uid: 'a', value: 'history' };
  const away = persistStep(opened, 'a', undefined);
  expect(away).toEqual({ write: false, next: opened });
  expect(persistStep(away.next, 'a', 'history').write).toBe(false);
  expect(persistStep(away.next, 'a', 'comments').write).toBe(true);
});
