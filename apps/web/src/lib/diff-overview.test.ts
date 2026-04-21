/// <reference types="bun" />

import { expect, test } from 'bun:test';
import {
  buildDiffOverviewMarkers,
  buildMeasuredDiffOverviewMarkers,
  getDiffOverviewViewport,
} from './diff-overview.js';

test('groups adjacent added and removed runs into overview markers', () => {
  const markers = buildDiffOverviewMarkers([
    { op: 'equal', text: 'alpha' },
    { op: 'remove', text: 'beta' },
    { op: 'remove', text: 'gamma' },
    { op: 'add', text: 'delta' },
    { op: 'equal', text: 'epsilon' },
    { op: 'add', text: 'zeta' },
  ]);

  expect(markers).toHaveLength(3);
  expect(markers[0]).toMatchObject({ op: 'remove', startLine: 1, lineCount: 2 });
  expect(markers[1]).toMatchObject({ op: 'add', startLine: 3, lineCount: 1 });
  expect(markers[2]).toMatchObject({ op: 'add', startLine: 5, lineCount: 1 });
  expect(markers[0]?.topPercent).toBeCloseTo((1 / 6) * 100);
  expect(markers[0]?.heightPercent).toBeCloseTo((2 / 6) * 100);
});

test('computes the visible viewport for an overflowing diff', () => {
  const viewport = getDiffOverviewViewport({
    scrollTop: 240,
    scrollHeight: 1200,
    clientHeight: 300,
  });

  expect(viewport).toEqual({
    topPercent: 20,
    heightPercent: 25,
  });
});

test('omits the viewport when the diff fits without scrolling', () => {
  expect(
    getDiffOverviewViewport({
      scrollTop: 0,
      scrollHeight: 300,
      clientHeight: 300,
    }),
  ).toBeNull();
});

test('uses measured row heights so wrapped lines land at their real positions', () => {
  const markers = buildMeasuredDiffOverviewMarkers({
    lines: [
      { op: 'equal', text: 'alpha' },
      { op: 'remove', text: 'beta' },
      { op: 'add', text: 'gamma' },
      { op: 'equal', text: 'delta' },
    ],
    lineLayouts: [
      { top: 0, bottom: 24 },
      { top: 24, bottom: 88 },
      { top: 88, bottom: 176 },
      { top: 176, bottom: 200 },
    ],
    scrollHeight: 200,
  });

  expect(markers).toHaveLength(2);
  expect(markers[0]).toMatchObject({
    op: 'remove',
    startLine: 1,
    lineCount: 1,
    topPercent: 12,
    heightPercent: 32,
  });
  expect(markers[1]).toMatchObject({
    op: 'add',
    startLine: 2,
    lineCount: 1,
    topPercent: 44,
    heightPercent: 44,
  });
});
