/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
  countDocMetaCharacters,
  isAddRowDismissed,
  readOpenState,
  writeOpenState,
} from './doc-meta-fold.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('countDocMetaCharacters', () => {
  test('counts paragraphs one line break apart and collapses whitespace', () => {
    expect(countDocMetaCharacters(['  Frankfurt,\n  2015. ', '', 'Felix.'])).toBe(
      'Frankfurt, 2015.\nFelix.'.length,
    );
  });

  test('counts code points, so an emoji is one character', () => {
    expect(countDocMetaCharacters(['é 🚲'])).toBe(3);
  });

  test('has no limit', () => {
    expect(countDocMetaCharacters(['x'.repeat(2000), 'y'.repeat(999)])).toBe(3000);
  });
});

describe('fold open state', () => {
  test('round-trips per document', () => {
    const storage = memoryStorage();
    writeOpenState('doc-a', 'summary', true, storage);
    writeOpenState('doc-b', 'about', true, storage);
    expect(readOpenState('doc-a', storage)).toEqual({ summary: true });
    expect(readOpenState('doc-b', storage)).toEqual({ about: true });
    writeOpenState('doc-a', 'summary', false, storage);
    expect(readOpenState('doc-a', storage)).toEqual({});
  });

  test('reads malformed or foreign values as all closed', () => {
    const storage = memoryStorage({
      'marginalia.docMeta.bad': '{not json',
      'marginalia.docMeta.odd': '{"summary":"yes","chapter":true,"about":true}',
      'marginalia.docMeta.null': 'null',
    });
    expect(readOpenState('bad', storage)).toEqual({});
    expect(readOpenState('odd', storage)).toEqual({ about: true });
    expect(readOpenState('null', storage)).toEqual({});
  });

  test('survives storage that throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readOpenState('doc', blocked)).toEqual({});
    expect(() => writeOpenState('doc', 'summary', true, blocked)).not.toThrow();
  });
});

describe('add row', () => {
  test('stays until dismissed for that document', () => {
    const storage = memoryStorage({ 'marginalia.docMetaAdd.doc-a': 'dismissed' });
    expect(isAddRowDismissed('doc-a', storage)).toBe(true);
    expect(isAddRowDismissed('doc-b', storage)).toBe(false);
  });
});
