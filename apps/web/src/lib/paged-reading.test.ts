import { describe, expect, test } from 'bun:test';
import { clampPage, pageCountOf, pageIndexAt, pageIndexOfOffset } from './paged-reading.js';

describe('pageCountOf', () => {
  test('a document shorter than one page is still one page', () => {
    expect(pageCountOf(400, 800)).toBe(1);
    expect(pageCountOf(0, 800)).toBe(1);
  });

  test('the missing trailing gap does not add a phantom page', () => {
    // Three 800px pages with a 32px gap measure 3 * 800 - 32.
    expect(pageCountOf(2368, 800)).toBe(3);
  });

  test('an exact multiple of the pitch counts as that many pages', () => {
    expect(pageCountOf(2400, 800)).toBe(3);
  });

  test('a sliver past a page boundary opens the next page', () => {
    expect(pageCountOf(1602, 800)).toBe(3);
  });

  test('an unmeasurable pitch degrades to a single page', () => {
    expect(pageCountOf(2400, 0)).toBe(1);
  });
});

describe('pageIndexAt', () => {
  test('reads the page a settled scroll offset rests on', () => {
    expect(pageIndexAt(0, 800)).toBe(0);
    expect(pageIndexAt(1600, 800)).toBe(2);
  });

  test('rounds a scroll left mid-turn to the nearer page', () => {
    expect(pageIndexAt(830, 800)).toBe(1);
    expect(pageIndexAt(1180, 800)).toBe(1);
  });

  test('never reports a negative page for an overscrolled container', () => {
    expect(pageIndexAt(-40, 800)).toBe(0);
  });
});

describe('pageIndexOfOffset', () => {
  test('content at a page start belongs to that page', () => {
    expect(pageIndexOfOffset(1600, 800)).toBe(2);
  });

  test('the centring margin does not round content into the next page', () => {
    // A narrow reading column on a wide page can sit well past the
    // half-way mark; floor keeps it on its own page.
    expect(pageIndexOfOffset(1600 + 520, 800)).toBe(2);
  });

  test('content just before a boundary stays on the earlier page', () => {
    expect(pageIndexOfOffset(1599, 800)).toBe(1);
  });
});

describe('clampPage', () => {
  test('holds an index inside the document', () => {
    expect(clampPage(-3, 5)).toBe(0);
    expect(clampPage(9, 5)).toBe(4);
    expect(clampPage(2, 5)).toBe(2);
  });

  test('a single-page document clamps to page zero', () => {
    expect(clampPage(4, 1)).toBe(0);
  });

  test('survives a NaN from an unmeasured container', () => {
    expect(clampPage(Number.NaN, 5)).toBe(0);
  });
});

describe('a fractional pitch', () => {
  // Vertical pages are sized to a whole number of text lines, and line
  // heights are routinely fractional — 19px at 1.6 is 30.4. The pitch
  // has to carry that fraction: rounding it loses a sliver of a line on
  // every page, always in the same direction.
  const LINE = 30.4;
  const PITCH = 27 * LINE; // 820.8 — a 27-line page

  test('round-trips every page boundary, however deep', () => {
    for (const page of [0, 1, 37, 199]) {
      expect(pageIndexAt(page * PITCH, PITCH)).toBe(page);
      expect(pageIndexOfOffset(page * PITCH, PITCH)).toBe(page);
    }
  });

  test('keeps content just short of a boundary on its own page', () => {
    expect(pageIndexOfOffset(200 * PITCH - 0.5, PITCH)).toBe(199);
  });

  test('a pitch rounded to whole pixels drifts a page out by 200', () => {
    // Why `pitchOf` measures the border box instead of the rounded
    // `clientHeight`: 0.2px per page is a whole line by page 130 and a
    // whole page not long after, so the reader is handed the end of the
    // previous page and half a line of this one.
    const rounded = Math.round(PITCH); // 821
    expect(pageIndexOfOffset(199 * PITCH, rounded)).toBe(198);
  });
});
