/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { windowedRange } from './windowedRange.js';

/**
 * The windowing arithmetic, separated from React so the cases that
 * actually bit can be pinned: a pinned row far down the list used to
 * stretch the range to reach it, which rendered every row in between —
 * the whole list, which is the thing windowing exists to avoid.
 */
const HEIGHT = 100;
const keys = Array.from({ length: 1000 }, (_, i) => `t${i}`);
const heights = new Map(keys.map((k) => [k, HEIGHT]));

function range(over: Partial<Parameters<typeof windowedRange>[0]> = {}) {
  return windowedRange({
    keys,
    heights,
    estimateHeight: HEIGHT,
    viewportTop: 0,
    viewportHeight: 600,
    overscanPx: 0,
    pinnedKey: null,
    ...over,
  });
}

describe('windowedRange', () => {
  test('renders only the rows the viewport covers', () => {
    const r = range();

    expect(r.start).toBe(0);
    expect(r.end).toBeLessThanOrEqual(8);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((keys.length - r.end) * HEIGHT);
  });

  test('moves the window down as the viewport scrolls', () => {
    const r = range({ viewportTop: 50_000 });

    // Row 499 ends exactly where the viewport begins and is kept, so the
    // window never starts mid-gap on a boundary.
    expect(r.start).toBe(499);
    expect(r.padTop).toBe(499 * HEIGHT);
    expect(r.end).toBeGreaterThan(r.start);
  });

  test('the spacers always account for every row outside the window', () => {
    const r = range({ viewportTop: 20_000 });
    const rendered = (r.end - r.start) * HEIGHT;

    expect(r.padTop + rendered + r.padBottom).toBe(keys.length * HEIGHT);
  });

  test('overscan keeps rows rendered beyond the viewport edges', () => {
    const tight = range({ viewportTop: 50_000, overscanPx: 0 });
    const loose = range({ viewportTop: 50_000, overscanPx: 900 });

    expect(loose.start).toBeLessThan(tight.start);
    expect(loose.end).toBeGreaterThan(tight.end);
  });

  test('a pinned row below the window is rendered without dragging the rest in', () => {
    // The regression: reaching a row 900 places down by extending `end`
    // renders 900 cards. The window moves to it instead.
    const r = range({ viewportTop: 0, pinnedKey: 't900' });

    expect(r.start).toBeLessThanOrEqual(900);
    expect(r.end).toBeGreaterThan(900);
    expect(r.end - r.start).toBeLessThan(20);
    expect(r.padTop + (r.end - r.start) * HEIGHT + r.padBottom).toBe(keys.length * HEIGHT);
  });

  test('a pinned row above the window is rendered without dragging the rest in', () => {
    const r = range({ viewportTop: 90_000, pinnedKey: 't10' });

    expect(r.start).toBeLessThanOrEqual(10);
    expect(r.end).toBeGreaterThan(10);
    expect(r.end - r.start).toBeLessThan(20);
  });

  test('a pinned row already on screen leaves the window alone', () => {
    const plain = range({ viewportTop: 50_000 });
    const pinned = range({ viewportTop: 50_000, pinnedKey: 't505' });

    expect(pinned).toEqual(plain);
  });

  test('rows never measured fall back to the estimate', () => {
    const r = windowedRange({
      keys,
      heights: new Map(),
      estimateHeight: 160,
      viewportTop: 16_000,
      viewportHeight: 600,
      overscanPx: 0,
      pinnedKey: null,
    });

    expect(r.start).toBe(99);
    expect(r.padTop).toBe(99 * 160);
  });

  test('an empty list windows to nothing', () => {
    const r = windowedRange({
      keys: [],
      heights: new Map(),
      estimateHeight: HEIGHT,
      viewportTop: 0,
      viewportHeight: 600,
      overscanPx: 0,
      pinnedKey: null,
    });

    expect(r).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
});
