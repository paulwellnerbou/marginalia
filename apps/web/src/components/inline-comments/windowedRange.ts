/**
 * Which rows a windowed list should render, and how tall the spacers
 * standing in for the rest must be.
 *
 * Kept apart from the hook that drives it so the arithmetic can be tested
 * without a DOM: the interesting cases are all about which rows end up in
 * the range, and none of them need a browser to state.
 */

/** Rows kept either side of a pinned row, so it does not sit against the edge. */
export const PINNED_CONTEXT_ROWS = 3;

export interface WindowedRangeInput {
  /** Keys of every row, in render order. */
  keys: readonly string[];
  /** Measured heights, by key. Rows absent here use `estimateHeight`. */
  heights: ReadonlyMap<string, number>;
  /** Assumed height of a row that has not been measured yet. */
  estimateHeight: number;
  /** Where the viewport starts, in the list's own coordinates. */
  viewportTop: number;
  /** How tall the viewport is. */
  viewportHeight: number;
  /** How far beyond the viewport to keep rendered. */
  overscanPx: number;
  /** A row that must be rendered wherever it is, or null. */
  pinnedKey: string | null;
}

export interface WindowedRange {
  /** First row to render (inclusive). */
  start: number;
  /** Last row to render (exclusive). */
  end: number;
  /** Height of the spacer standing in for rows before `start`. */
  padTop: number;
  /** Height of the spacer standing in for rows after `end`. */
  padBottom: number;
}

export function windowedRange({
  keys,
  heights,
  estimateHeight,
  viewportTop,
  viewportHeight,
  overscanPx,
  pinnedKey,
}: WindowedRangeInput): WindowedRange {
  if (keys.length === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const heightAt = (i: number) => {
    const key = keys[i];
    return (key === undefined ? undefined : heights.get(key)) ?? estimateHeight;
  };

  // Walk the rows once, accumulating offsets, to find the first and last
  // that fall inside the viewport plus overscan.
  const from = viewportTop - overscanPx;
  const to = viewportTop + viewportHeight + overscanPx;
  let offset = 0;
  let start = 0;
  let end = keys.length;
  let padTop = 0;
  for (let i = 0; i < keys.length; i++) {
    const h = heightAt(i);
    if (offset + h < from) {
      start = i + 1;
      padTop = offset + h;
    } else if (offset > to) {
      end = i;
      break;
    }
    offset += h;
  }
  if (start > end) start = end;

  // The focused thread has to be in the DOM for the scroll and flash that
  // follow it, even when it is far outside the window. Re-centre on it
  // rather than stretching the range to reach it: stretching would render
  // every row in between, which for a thread a thousand rows down is the
  // whole list. The focus effect scrolls there immediately, so this band
  // is where the reader is about to be looking anyway.
  if (pinnedKey !== null) {
    const pinned = keys.indexOf(pinnedKey);
    if (pinned >= 0 && (pinned < start || pinned >= end)) {
      start = Math.max(0, pinned - PINNED_CONTEXT_ROWS);
      end = Math.min(keys.length, pinned + PINNED_CONTEXT_ROWS + 1);
      padTop = 0;
      for (let i = 0; i < start; i++) padTop += heightAt(i);
    }
  }

  let padBottom = 0;
  for (let i = end; i < keys.length; i++) padBottom += heightAt(i);

  return { start, end, padTop, padBottom };
}
