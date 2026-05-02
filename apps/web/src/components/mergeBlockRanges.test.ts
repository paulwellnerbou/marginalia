import { describe, expect, test } from 'bun:test';
import type { BlockSourceRange } from '@marginalia/renderer';
import { mergeBlockRanges } from './mergeBlockRanges.js';

function makeRanges(entries: Array<[string, BlockSourceRange]>): Map<string, BlockSourceRange> {
  return new Map(entries);
}

describe('mergeBlockRanges', () => {
  test('returns the start range when endId is null', () => {
    const ranges = makeRanges([
      ['p1', { start: 0, end: 10, kind: 'paragraph', text: 'first' }],
    ]);
    expect(mergeBlockRanges(ranges, 'p1', null, 'markdown')).toEqual({ start: 0, end: 10 });
  });

  test('returns the start range when endId equals startId', () => {
    const ranges = makeRanges([
      ['p1', { start: 0, end: 10, kind: 'paragraph', text: 'first' }],
    ]);
    expect(mergeBlockRanges(ranges, 'p1', 'p1', 'markdown')).toEqual({ start: 0, end: 10 });
  });

  test('returns null when either endpoint is unknown', () => {
    const ranges = makeRanges([
      ['p1', { start: 0, end: 10, kind: 'paragraph', text: 'a' }],
    ]);
    expect(mergeBlockRanges(ranges, 'p1', 'nope', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'nope', 'p1', 'markdown')).toBeNull();
  });

  test('merges paragraph endpoints (min start, max end)', () => {
    const ranges = makeRanges([
      ['a', { start: 0, end: 10, kind: 'paragraph', text: 'a' }],
      ['b', { start: 12, end: 20, kind: 'paragraph', text: 'b' }],
      ['c', { start: 22, end: 30, kind: 'paragraph', text: 'c' }],
    ]);
    expect(mergeBlockRanges(ranges, 'a', 'c', 'markdown')).toEqual({ start: 0, end: 30 });
    // Reversed order still merges (min/max).
    expect(mergeBlockRanges(ranges, 'c', 'a', 'markdown')).toEqual({ start: 0, end: 30 });
  });

  test('rejects tableCell endpoints regardless of format', () => {
    const ranges = makeRanges([
      ['p1', { start: 0, end: 10, kind: 'paragraph', text: 'p' }],
      ['c1', { start: 12, end: 14, kind: 'tableCell', text: 'A' }],
      ['c2', { start: 16, end: 18, kind: 'tableCell', text: 'B' }],
    ]);
    expect(mergeBlockRanges(ranges, 'c1', 'c2', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'p1', 'c1', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'c1', 'p1', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'c1', 'c2', 'asciidoc')).toBeNull();
    // Single-block (endId === startId) bypasses validation.
    expect(mergeBlockRanges(ranges, 'c1', null, 'markdown')).toEqual({ start: 12, end: 14 });
  });

  test('accepts listItem endpoints in markdown', () => {
    const ranges = makeRanges([
      ['i1', { start: 0, end: 6, kind: 'listItem', text: 'one' }],
      ['i2', { start: 6, end: 12, kind: 'listItem', text: 'two' }],
      ['i3', { start: 12, end: 20, kind: 'listItem', text: 'three' }],
    ]);
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'markdown')).toEqual({ start: 0, end: 12 });
    expect(mergeBlockRanges(ranges, 'i1', 'i3', 'markdown')).toEqual({ start: 0, end: 20 });
  });

  test('rejects listItem endpoints in asciidoc (best-effort source ranges)', () => {
    const ranges = makeRanges([
      ['i1', { start: 0, end: 6, kind: 'listItem', text: 'one' }],
      ['i2', { start: 6, end: 12, kind: 'listItem', text: 'two' }],
      ['p1', { start: 14, end: 24, kind: 'paragraph', text: 'p' }],
    ]);
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'asciidoc')).toBeNull();
    expect(mergeBlockRanges(ranges, 'i1', 'p1', 'asciidoc')).toBeNull();
    expect(mergeBlockRanges(ranges, 'p1', 'i1', 'asciidoc')).toBeNull();
    // Single-block (endId === startId) still works.
    expect(mergeBlockRanges(ranges, 'i1', null, 'asciidoc')).toEqual({ start: 0, end: 6 });
  });

  test('mixed listItem ↔ paragraph in markdown is accepted', () => {
    const ranges = makeRanges([
      ['p', { start: 0, end: 10, kind: 'paragraph', text: 'intro' }],
      ['i', { start: 12, end: 18, kind: 'listItem', text: 'one' }],
    ]);
    expect(mergeBlockRanges(ranges, 'p', 'i', 'markdown')).toEqual({ start: 0, end: 18 });
  });
});
