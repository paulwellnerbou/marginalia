/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { type HighlightRange, mergeRanges } from './highlight-ranges.js';

const open = (id: string) => ({ id, state: 'open' as const });
const resolved = (id: string) => ({ id, state: 'resolved' as const });

function range(rawStart: number, rawEnd: number, ...threads: HighlightRange['threads']) {
  return { rawStart, rawEnd, threads };
}

test('overlapping open ranges paint as one mark listing both threads', () => {
  expect(mergeRanges([range(0, 10, open('a')), range(5, 20, open('b'))])).toEqual([
    { rawStart: 0, rawEnd: 20, threads: [open('a'), open('b')], visible: true },
  ]);
});

test('touching ranges that paint alike join', () => {
  expect(mergeRanges([range(0, 10, open('a')), range(10, 20, open('b'))])).toEqual([
    { rawStart: 0, rawEnd: 20, threads: [open('a'), open('b')], visible: true },
  ]);
});

test('an open comment inside a resolved one tints only its own words', () => {
  // The resolved thread covers the whole paragraph, as one an accept
  // re-anchored onto the new text does.
  expect(mergeRanges([range(0, 50, resolved('r')), range(10, 20, open('a'))])).toEqual([
    { rawStart: 0, rawEnd: 10, threads: [resolved('r')], visible: false },
    { rawStart: 10, rawEnd: 20, threads: [resolved('r'), open('a')], visible: true },
    { rawStart: 20, rawEnd: 50, threads: [resolved('r')], visible: false },
  ]);
});

test('the pending range stays tinted inside a resolved one', () => {
  expect(mergeRanges([range(0, 50, resolved('r')), range(10, 20)])).toEqual([
    { rawStart: 0, rawEnd: 10, threads: [resolved('r')], visible: false },
    { rawStart: 10, rawEnd: 20, threads: [resolved('r')], visible: true },
    { rawStart: 20, rawEnd: 50, threads: [resolved('r')], visible: false },
  ]);
});

test('separate ranges stay separate', () => {
  expect(mergeRanges([range(30, 40, open('b')), range(0, 10, open('a'))])).toEqual([
    { rawStart: 0, rawEnd: 10, threads: [open('a')], visible: true },
    { rawStart: 30, rawEnd: 40, threads: [open('b')], visible: true },
  ]);
});
