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

  test('rejects tableCell endpoints', () => {
    const ranges = makeRanges([
      ['p1', { start: 0, end: 10, kind: 'paragraph', text: 'p' }],
      ['c1', { start: 12, end: 14, kind: 'tableCell', text: 'A' }],
      ['c2', { start: 16, end: 18, kind: 'tableCell', text: 'B' }],
    ]);
    expect(mergeBlockRanges(ranges, 'c1', 'c2', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'p1', 'c1', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'c1', 'p1', 'markdown')).toBeNull();
    // Single-block (endId === startId) bypasses validation.
    expect(mergeBlockRanges(ranges, 'c1', null, 'markdown')).toEqual({ start: 12, end: 14 });
  });

  test('accepts listItem endpoints sharing the same parentStart', () => {
    const ranges = makeRanges([
      ['i1', { start: 0, end: 6, kind: 'listItem', text: 'one', parentStart: 0 }],
      ['i2', { start: 6, end: 12, kind: 'listItem', text: 'two', parentStart: 0 }],
      ['i3', { start: 12, end: 20, kind: 'listItem', text: 'three', parentStart: 0 }],
    ]);
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'markdown')).toEqual({ start: 0, end: 12 });
    expect(mergeBlockRanges(ranges, 'i1', 'i3', 'markdown')).toEqual({ start: 0, end: 20 });
  });

  test('rejects listItem endpoints with different parentStart (cross-depth or different lists)', () => {
    const ranges = makeRanges([
      ['outer1', { start: 0, end: 8, kind: 'listItem', text: 'o1', parentStart: 0 }],
      ['nested', { start: 10, end: 16, kind: 'listItem', text: 'n', parentStart: 10 }],
      ['outer2', { start: 18, end: 26, kind: 'listItem', text: 'o2', parentStart: 0 }],
    ]);
    // Cross-depth: nested ↔ outer sibling rejected.
    expect(mergeBlockRanges(ranges, 'nested', 'outer2', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'outer1', 'nested', 'markdown')).toBeNull();
    // Same parent (both outer): accepted.
    expect(mergeBlockRanges(ranges, 'outer1', 'outer2', 'markdown')).toEqual({ start: 0, end: 26 });
  });

  test('rejects listItem endpoints without parentStart in markdown', () => {
    // Defensive: even if a listItem range somehow lacks `parentStart`
    // under markdown, the predicate refuses to merge — the
    // same-parent invariant can't be verified.
    const ranges = makeRanges([
      ['i1', { start: 0, end: 6, kind: 'listItem', text: 'one' }],
      ['i2', { start: 6, end: 12, kind: 'listItem', text: 'two' }],
    ]);
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'i1', null, 'markdown')).toEqual({ start: 0, end: 6 });
  });

  test('rejects listItem endpoints in asciidoc explicitly (regardless of parentStart)', () => {
    // Even with parentStart populated, asciidoc multi-listItem is
    // unsafe (best-effort source range, no continuation support).
    // The predicate's `format` arg must reject these explicitly so
    // future changes to the asciidoc walker can't silently re-enable
    // the unsafe path.
    const ranges = makeRanges([
      ['i1', { start: 0, end: 6, kind: 'listItem', text: 'one', parentStart: 0 }],
      ['i2', { start: 6, end: 12, kind: 'listItem', text: 'two', parentStart: 0 }],
    ]);
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'asciidoc')).toBeNull();
    // Markdown still accepts (sanity).
    expect(mergeBlockRanges(ranges, 'i1', 'i2', 'markdown')).toEqual({ start: 0, end: 12 });
    // Single-block (endId === startId) bypass works in both formats.
    expect(mergeBlockRanges(ranges, 'i1', null, 'asciidoc')).toEqual({ start: 0, end: 6 });
  });

  test('rejects mixed listItem/paragraph endpoints', () => {
    const ranges = makeRanges([
      ['p', { start: 0, end: 10, kind: 'paragraph', text: 'intro' }],
      ['i', { start: 12, end: 18, kind: 'listItem', text: 'one', parentStart: 12 }],
    ]);
    expect(mergeBlockRanges(ranges, 'p', 'i', 'markdown')).toBeNull();
    expect(mergeBlockRanges(ranges, 'i', 'p', 'markdown')).toBeNull();
  });
});
