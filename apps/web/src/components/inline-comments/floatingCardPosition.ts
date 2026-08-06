/**
 * Pure geometry for the floating-comments popover. All coordinates are
 * in "host space": pixels relative to the top-left of the positioning
 * host that fills the document row, so a card placed at these offsets
 * scrolls with the document for free.
 */

export interface FloatingCardPlacementInput {
  /** Anchor rect edges in host space. */
  anchorTop: number;
  anchorBottom: number;
  anchorLeft: number;
  /** Width of the positioning host (the document row). */
  hostWidth: number;
  /** Measured card size. */
  cardWidth: number;
  cardHeight: number;
  /** Visible window of the scroll container, in host space. */
  viewTop: number;
  viewHeight: number;
  gap?: number;
  margin?: number;
}

export interface FloatingCardPosition {
  top: number;
  left: number;
  placement: 'below' | 'above';
}

const DEFAULT_GAP = 8;
const DEFAULT_MARGIN = 12;

/**
 * Place the card below its anchor, flipping above only when the card
 * doesn't fit in the visible window below but does fit above. When it
 * fits in neither direction, below wins — the reader scrolls down
 * through the card, matching how the column reads.
 */
export function computeFloatingCardPosition(
  input: FloatingCardPlacementInput,
): FloatingCardPosition {
  const gap = input.gap ?? DEFAULT_GAP;
  const margin = input.margin ?? DEFAULT_MARGIN;

  const belowTop = input.anchorBottom + gap;
  const aboveTop = input.anchorTop - gap - input.cardHeight;
  const viewBottom = input.viewTop + input.viewHeight;

  const fitsBelow = belowTop + input.cardHeight <= viewBottom;
  const fitsAbove = aboveTop >= input.viewTop && aboveTop >= 0;

  const placement: 'below' | 'above' = !fitsBelow && fitsAbove ? 'above' : 'below';
  const top = Math.max(placement === 'above' ? aboveTop : belowTop, 0);
  const left = clampCardLeft(input.anchorLeft, input.cardWidth, input.hostWidth, margin);
  return { top, left, placement };
}

/**
 * Align the card's left edge with the anchor, kept inside the host —
 * the scroll container hides horizontal overflow, so an unclamped card
 * would be cut off. A card wider than the host (minus margins) is
 * centered instead.
 */
export function clampCardLeft(
  anchorLeft: number,
  cardWidth: number,
  hostWidth: number,
  margin: number = DEFAULT_MARGIN,
): number {
  const max = hostWidth - cardWidth - margin;
  if (max < margin) return Math.max((hostWidth - cardWidth) / 2, 0);
  return Math.min(Math.max(anchorLeft, margin), max);
}

export interface ThreadTopEntry {
  id: string;
  /** Anchor top relative to the scroll container's visible top edge. */
  top: number;
  /**
   * Document-order tiebreak for threads sharing an anchor position:
   * where the quote starts within its block, then when the thread was
   * created. Matches how the column orders the same threads, so the
   * two presentations step through them in the same sequence.
   */
  startOffset?: number;
  createdAt?: number;
}

/** Sort into the order prev/next steps through. */
export function sortThreadTopEntries(entries: ThreadTopEntry[]): ThreadTopEntry[] {
  return entries.sort(
    (a, b) =>
      a.top - b.top ||
      (a.startOffset ?? 0) - (b.startOffset ?? 0) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
}

/**
 * Index of the thread the reader is on. `entries` must be sorted by
 * `top` ascending.
 *
 * `parkedId` is the thread the caller knows the reader was last taken
 * to and has not scrolled away from. It wins outright, because position
 * alone cannot separate threads quoting the same text: they resolve to
 * the same anchor, so they tie, and picking by position would always
 * name the same one of them — stepping past the rest.
 *
 * Without it, the current thread is the last one whose anchor sits at
 * or above `refTop` (a small pad below the container's top edge).
 * Returns -1 above the first thread.
 */
export function currentThreadIndex(
  entries: ThreadTopEntry[],
  refTop: number,
  parkedId?: string | null,
): number {
  if (parkedId) {
    const parked = entries.findIndex((entry) => entry.id === parkedId);
    if (parked >= 0) return parked;
  }
  let current = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.top <= refTop) current = i;
    else break;
  }
  return current;
}

/**
 * Pick the previous/next thread relative to the reading position.
 * `entries` must be sorted by `top` ascending; see `currentThreadIndex`
 * for how the current thread is chosen. Mirrors the column toolbar's
 * findCurrentIndex semantics.
 */
export function adjacentThreadTarget(
  entries: ThreadTopEntry[],
  refTop: number,
  direction: -1 | 1,
  parkedId?: string | null,
): string | null {
  const current = currentThreadIndex(entries, refTop, parkedId);
  if (direction > 0) return entries[current + 1]?.id ?? null;
  return current > 0 ? (entries[current - 1]?.id ?? null) : null;
}
