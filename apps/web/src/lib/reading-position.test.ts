/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';
import {
  forgetReadingPosition,
  loadReadingPosition,
  type ReadingPosition,
  saveReadingPosition,
} from './reading-position.js';

const KEY = 'marginalia.readingPositions';
const store = new Map<string, string>();

// bun's test environment has no DOM; localStorage is the only dependency
// of the storage half.
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => store.clear());

const at = (offset: number): ReadingPosition => ({
  block: 'b1',
  copy: 0,
  ordinal: 3,
  offset,
  top: 12,
});

test('a saved position comes back for its own document only', () => {
  saveReadingPosition('a', at(5));
  expect(loadReadingPosition('a')).toEqual(at(5));
  expect(loadReadingPosition('b')).toBeNull();
});

test('saving again replaces the old position', () => {
  saveReadingPosition('a', at(5));
  saveReadingPosition('a', at(9));
  expect(loadReadingPosition('a')).toEqual(at(9));
  expect(JSON.parse(store.get(KEY) ?? '[]')).toHaveLength(1);
});

test('the document read longest ago is the one dropped', () => {
  for (let i = 0; i < 50; i++) saveReadingPosition(`doc${i}`, at(i));
  // Re-reading doc0 makes it the freshest, so doc1 gives way instead.
  saveReadingPosition('doc0', at(0));
  saveReadingPosition('new', at(1));
  expect(loadReadingPosition('doc0')).toEqual(at(0));
  expect(loadReadingPosition('doc1')).toBeNull();
  expect(loadReadingPosition('new')).toEqual(at(1));
});

test('forgetting removes just that document', () => {
  saveReadingPosition('a', at(1));
  saveReadingPosition('b', at(2));
  forgetReadingPosition('a');
  expect(loadReadingPosition('a')).toBeNull();
  expect(loadReadingPosition('b')).toEqual(at(2));
});

test('unreadable storage reads as nothing remembered', () => {
  store.set(KEY, '{not json');
  expect(loadReadingPosition('a')).toBeNull();
  store.set(KEY, JSON.stringify([{ uid: 'a', block: 'b1' }, 'junk']));
  expect(loadReadingPosition('a')).toBeNull();
});
