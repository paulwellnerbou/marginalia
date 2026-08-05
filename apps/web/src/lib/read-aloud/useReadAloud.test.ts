import { describe, expect, test } from 'bun:test';
import type { ReadAloudSegment } from './segment.js';
import { findResumeIndex } from './useReadAloud.js';

function segment(text: string, blockId: string | null, start = 0): ReadAloudSegment {
  return {
    id: `${blockId ?? 'none'}-${start}`,
    text,
    start,
    end: start + text.length,
    blockId,
    // Never dereferenced by findResumeIndex.
    blockEl: {} as HTMLElement,
  };
}

describe('findResumeIndex', () => {
  test('pins the exact occurrence when the same text repeats', () => {
    // Two table cells reading "Ja." — matching on text alone would
    // jump the reader back to the first one.
    const segments = [
      segment('Ja.', 'block-a'),
      segment('Etwas dazwischen.', 'block-b'),
      segment('Ja.', 'block-c'),
    ];
    expect(findResumeIndex(segments, segment('Ja.', 'block-c'))).toBe(2);
  });

  test('distinguishes repeats inside one block by offset', () => {
    const segments = [segment('Ja.', 'block-a', 0), segment('Ja.', 'block-a', 4)];
    expect(findResumeIndex(segments, segment('Ja.', 'block-a', 4))).toBe(1);
  });

  test('falls back to text when the renderer emitted no block id', () => {
    const segments = [segment('Erster Satz.', null), segment('Zweiter Satz.', null)];
    expect(findResumeIndex(segments, segment('Zweiter Satz.', null))).toBe(1);
  });

  test('falls back to text when the block was rewritten', () => {
    // The block's content hash changed (an edit elsewhere in it), but
    // this sentence survived — keep reading rather than stopping.
    const segments = [segment('Unverändert.', 'block-new', 12)];
    expect(findResumeIndex(segments, segment('Unverändert.', 'block-old', 0))).toBe(0);
  });

  test('reports no match when the sentence is gone', () => {
    const segments = [segment('Etwas anderes.', 'block-a')];
    expect(findResumeIndex(segments, segment('Gelöschter Satz.', 'block-b'))).toBe(-1);
  });
});
