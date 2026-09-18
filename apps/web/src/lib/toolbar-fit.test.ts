/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { nextFitStage } from './toolbar-fit.js';

const LAST = 2;

test('keeps the full bar while it fits', () => {
  expect(nextFitStage(0, [480], 600, LAST)).toBe(0);
  expect(nextFitStage(0, [480], 480, LAST)).toBe(0);
});

test('folds one stage when the bar overflows', () => {
  expect(nextFitStage(0, [554], 292, LAST)).toBe(1);
  expect(nextFitStage(1, [554, 300], 292, LAST)).toBe(2);
});

test('keeps folding through every stage it is given', () => {
  // The bar's own stages: full, folded, folded with a shorter View,
  // folded with the page's Edit gone too.
  expect(nextFitStage(2, [554, 300, 250], 200, 3)).toBe(3);
});

test('stops at the last stage even if that still overflows', () => {
  expect(nextFitStage(2, [554, 300, 250], 200, LAST)).toBe(2);
});

test('unfolds once the wider stage fits again', () => {
  expect(nextFitStage(2, [554, 280, 230], 292, LAST)).toBe(1);
  expect(nextFitStage(1, [554, 280], 600, LAST)).toBe(0);
});

test('stays folded while the wider stage would still overflow', () => {
  expect(nextFitStage(1, [554, 280], 553, LAST)).toBe(1);
});

test('cannot unfold without a measurement of the wider stage', () => {
  expect(nextFitStage(1, [undefined, 280], 900, LAST)).toBe(1);
});

test('does not flip back and forth at the width where the stages meet', () => {
  const needed = [400, 300];
  const folded = nextFitStage(0, needed, 399, LAST);
  expect(folded).toBe(1);
  expect(nextFitStage(folded, needed, 399, LAST)).toBe(1);
  const unfolded = nextFitStage(1, needed, 400, LAST);
  expect(unfolded).toBe(0);
  expect(nextFitStage(unfolded, needed, 400, LAST)).toBe(0);
});

test('ignores sub-pixel overflow', () => {
  expect(nextFitStage(0, [292.4], 292, LAST)).toBe(0);
  expect(nextFitStage(1, [292.4, 250], 292, LAST)).toBe(0);
});
