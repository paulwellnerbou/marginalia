/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { readTocCollapsed, writeTocCollapsed } from './toc-fold.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('TOC fold state', () => {
  test('starts open', () => {
    expect(readTocCollapsed('doc-a', memoryStorage())).toBe(false);
  });

  test('round-trips per document', () => {
    const storage = memoryStorage();
    writeTocCollapsed('doc-a', true, storage);
    expect(readTocCollapsed('doc-a', storage)).toBe(true);
    expect(readTocCollapsed('doc-b', storage)).toBe(false);
  });

  test('reopening forgets the entry instead of storing "open"', () => {
    const storage = memoryStorage();
    writeTocCollapsed('doc-a', true, storage);
    writeTocCollapsed('doc-a', false, storage);
    expect(storage.data.size).toBe(0);
  });

  test('blocked storage reads as open and does not throw', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTocCollapsed('doc-a', blocked)).toBe(false);
    expect(() => writeTocCollapsed('doc-a', true, blocked)).not.toThrow();
  });
});
