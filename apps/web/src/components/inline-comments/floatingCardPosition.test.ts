import { describe, expect, test } from 'bun:test';
import {
  adjacentThreadTarget,
  clampCardLeft,
  computeFloatingCardPosition,
  type FloatingCardPlacementInput,
} from './floatingCardPosition.js';

function input(overrides: Partial<FloatingCardPlacementInput>): FloatingCardPlacementInput {
  return {
    anchorTop: 500,
    anchorBottom: 520,
    anchorLeft: 100,
    hostWidth: 800,
    cardWidth: 400,
    cardHeight: 200,
    viewTop: 400,
    viewHeight: 600,
    ...overrides,
  };
}

describe('computeFloatingCardPosition', () => {
  test('places the card below the anchor when it fits in view', () => {
    const pos = computeFloatingCardPosition(input({}));
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(528);
    expect(pos.left).toBe(100);
  });

  test('flips above when there is no room below but room above', () => {
    // View is 400..1000; anchor near the bottom of the view.
    const pos = computeFloatingCardPosition(input({ anchorTop: 900, anchorBottom: 920 }));
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(900 - 8 - 200);
  });

  test('stays below when it fits in neither direction', () => {
    // Card taller than the visible window.
    const pos = computeFloatingCardPosition(
      input({ cardHeight: 700, anchorTop: 700, anchorBottom: 720 }),
    );
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(728);
  });

  test('never flips above the top of the content', () => {
    // Anchor near the very top of the document, view scrolled to 0.
    const pos = computeFloatingCardPosition(
      input({ anchorTop: 40, anchorBottom: 60, viewTop: 0, viewHeight: 200, cardHeight: 300 }),
    );
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(68);
  });

  test('respects a custom gap', () => {
    const pos = computeFloatingCardPosition(input({ gap: 20 }));
    expect(pos.top).toBe(540);
  });
});

describe('clampCardLeft', () => {
  test('keeps the card aligned with the anchor when it fits', () => {
    expect(clampCardLeft(100, 400, 800)).toBe(100);
  });

  test('clamps to the left margin', () => {
    expect(clampCardLeft(2, 400, 800)).toBe(12);
  });

  test('clamps to the right edge', () => {
    expect(clampCardLeft(700, 400, 800)).toBe(800 - 400 - 12);
  });

  test('centers a card wider than the host', () => {
    expect(clampCardLeft(50, 380, 400)).toBe(10);
    expect(clampCardLeft(50, 500, 400)).toBe(0);
  });
});

describe('adjacentThreadTarget', () => {
  const entries = [
    { id: 'a', top: -300 },
    { id: 'b', top: 10 },
    { id: 'c', top: 250 },
    { id: 'd', top: 900 },
  ];

  test('next steps to the first anchor below the reading position', () => {
    expect(adjacentThreadTarget(entries, 20, 1)).toBe('c');
  });

  test('next from above the first anchor lands on the first', () => {
    expect(adjacentThreadTarget(entries, -400, 1)).toBe('a');
  });

  test('next at the last anchor returns null', () => {
    expect(adjacentThreadTarget(entries, 1000, 1)).toBeNull();
  });

  test('prev steps back one anchor', () => {
    expect(adjacentThreadTarget(entries, 260, -1)).toBe('b');
  });

  test('prev on or above the first anchor returns null', () => {
    expect(adjacentThreadTarget(entries, -300, -1)).toBeNull();
    expect(adjacentThreadTarget(entries, -400, -1)).toBeNull();
  });

  test('empty list returns null both ways', () => {
    expect(adjacentThreadTarget([], 0, 1)).toBeNull();
    expect(adjacentThreadTarget([], 0, -1)).toBeNull();
  });
});
