import { describe, expect, test } from 'bun:test';
import {
  adjacentThreadTarget,
  clampCardLeft,
  computeFloatingCardPosition,
  currentThreadIndex,
  type FloatingCardPlacementInput,
  sortThreadTopEntries,
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

// Tops are signed distances from where a jump lands the anchor, so the
// reader always sits at 0: negative is scrolled past, positive is still
// ahead. REF stands in for the "already read" pad, which each toolbar
// sizes for itself — 4px in the column, 20px floating. Every entry below
// sits far enough from that boundary to step the same way under either,
// so these cases are about the rules, not about one toolbar's pad.
const REF = 4;

describe('adjacentThreadTarget', () => {
  // The reader sits on 'b', with 'a' behind them and 'c'/'d' ahead.
  const entries = [
    { id: 'a', top: -1200 },
    { id: 'b', top: 0 },
    { id: 'c', top: 250 },
    { id: 'd', top: 900 },
  ];

  test('next steps to the first anchor below the reading position', () => {
    expect(adjacentThreadTarget(entries, REF, 1)).toBe('c');
  });

  test('next from above the first anchor lands on the first', () => {
    expect(adjacentThreadTarget([{ id: 'a', top: 300 }], REF, 1)).toBe('a');
  });

  test('next at the last anchor returns null', () => {
    expect(adjacentThreadTarget(entries, REF, 1, 'd')).toBeNull();
  });

  test('prev steps back one anchor from the one being read', () => {
    expect(adjacentThreadTarget(entries, REF, -1)).toBe('a');
  });

  // The dead-arrow case: the comment is plainly above the viewport, so
  // "previous" means going back to it rather than over it.
  test('prev returns to the comment the reader has scrolled past', () => {
    const scrolledPast = [
      { id: 'a', top: -1900 },
      { id: 'b', top: -700 },
      { id: 'c', top: 250 },
    ];
    expect(adjacentThreadTarget(scrolledPast, REF, -1)).toBe('b');
  });

  test('prev returns to the only comment when it is above the reader', () => {
    expect(adjacentThreadTarget([{ id: 'a', top: -700 }], REF, -1)).toBe('a');
  });

  // Landing is exact within a couple of pixels; a jump that measured a
  // hair short must not count as having scrolled past.
  test('prev steps back from a thread the reader landed on inexactly', () => {
    const landedShort = [
      { id: 'a', top: -1200 },
      { id: 'b', top: -3 },
    ];
    expect(adjacentThreadTarget(landedShort, REF, -1)).toBe('a');
  });

  test('prev on or above the first anchor returns null', () => {
    expect(adjacentThreadTarget(entries, REF, -1, 'a')).toBeNull();
    expect(adjacentThreadTarget([{ id: 'a', top: 300 }], REF, -1)).toBeNull();
  });

  test('empty list returns null both ways', () => {
    expect(adjacentThreadTarget([], REF, 1)).toBeNull();
    expect(adjacentThreadTarget([], REF, -1)).toBeNull();
  });

  // Threads quoting the same text resolve to the same anchor, so they
  // tie. Position alone always names the last of a tie, which would
  // step straight past the others.
  describe('threads sharing an anchor position', () => {
    const tied = [
      { id: 'a', top: -300 },
      { id: 'b1', top: 0 },
      { id: 'b2', top: 0 },
      { id: 'c', top: 900 },
    ];

    test('without a parked thread, next skips past the whole tie', () => {
      expect(adjacentThreadTarget(tied, REF, 1)).toBe('c');
    });

    test('next walks from the first of a tie to the second', () => {
      expect(adjacentThreadTarget(tied, REF, 1, 'b1')).toBe('b2');
    });

    test('next leaves the tie only from its last member', () => {
      expect(adjacentThreadTarget(tied, REF, 1, 'b2')).toBe('c');
    });

    test('prev walks back through the tie symmetrically', () => {
      expect(adjacentThreadTarget(tied, REF, -1, 'b2')).toBe('b1');
      expect(adjacentThreadTarget(tied, REF, -1, 'b1')).toBe('a');
    });

    test('a parked thread that is gone falls back to position', () => {
      expect(adjacentThreadTarget(tied, REF, 1, 'filtered-out')).toBe('c');
    });

    test('prev from the first thread returns null even when parked', () => {
      expect(adjacentThreadTarget(tied, REF, -1, 'a')).toBeNull();
    });
  });

  // At either end of the document the scroll clamps, so the thread the
  // reader was taken to stops short of the landing line. The caller says
  // they are still on it, and that beats what the positions imply.
  test('a thread parked at a scroll limit steps off it, not back to it', () => {
    const clamped = [
      { id: 'a', top: -900 },
      { id: 'b', top: -500 },
      { id: 'c', top: -200 },
    ];
    expect(adjacentThreadTarget(clamped, REF, 1, 'b')).toBe('c');
    expect(adjacentThreadTarget(clamped, REF, -1, 'b')).toBe('a');
  });
});

describe('sortThreadTopEntries', () => {
  test('orders by position', () => {
    const sorted = sortThreadTopEntries([
      { id: 'b', top: 100 },
      { id: 'a', top: -20 },
      { id: 'c', top: 900 },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  // Threads on one anchor tie on position; the column orders them by
  // where the quote starts, so stepping must not depend on which
  // presentation the reader happens to be using.
  test('breaks a tie by quote start offset, then creation time', () => {
    const sorted = sortThreadTopEntries([
      { id: 'later', top: 0, startOffset: 40, createdAt: 1 },
      { id: 'oldest-at-10', top: 0, startOffset: 10, createdAt: 1 },
      { id: 'newest-at-10', top: 0, startOffset: 10, createdAt: 9 },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['oldest-at-10', 'newest-at-10', 'later']);
  });

  test('entries without tiebreak fields keep a stable order', () => {
    const sorted = sortThreadTopEntries([
      { id: 'first', top: 0 },
      { id: 'second', top: 0 },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['first', 'second']);
  });
});

describe('currentThreadIndex', () => {
  const entries = [
    { id: 'a', top: -300 },
    { id: 'b', top: 0 },
    { id: 'c', top: 250 },
  ];

  test('is the last anchor at or above the reading position', () => {
    expect(currentThreadIndex(entries, REF)).toBe(1);
  });

  test('is -1 above the first anchor', () => {
    expect(currentThreadIndex([{ id: 'a', top: 300 }], REF)).toBe(-1);
  });

  test('is the parked thread when one is given', () => {
    expect(currentThreadIndex(entries, REF, 'c')).toBe(2);
  });

  test('ignores a parked id that is not in the list', () => {
    expect(currentThreadIndex(entries, REF, 'nope')).toBe(1);
  });
});
