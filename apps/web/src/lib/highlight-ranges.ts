/**
 * Turning one block's comment ranges, which may overlap, into the
 * non-overlapping runs that get a `<mark>` each.
 */

import type { ThreadState } from './api.js';

export type RangeThread = { id: string; state: ThreadState };

/** Raw text offsets in one block. No threads = the pending range of a comment being written. */
export type HighlightRange = { rawStart: number; rawEnd: number; threads: RangeThread[] };

/** A run painted as one mark: tinted when `visible`, transparent otherwise. */
export type MergedHighlightRange = HighlightRange & { visible: boolean };

function isVisible(range: HighlightRange): boolean {
  return range.threads.length === 0 || range.threads.some((t) => t.state === 'open');
}

/**
 * Cut the ranges at every boundary, then join neighbouring pieces back
 * only where they paint alike. Each run lists every thread covering any
 * part of it, so scrolling to a thread still finds a mark.
 *
 * Joining across a change of tint would stretch the tint: a two-word
 * comment inside a resolved comment that an accept re-anchored onto the
 * whole new paragraph would paint that paragraph, and the pending range
 * of the comment being written would turn transparent.
 */
export function mergeRanges(ranges: readonly HighlightRange[]): MergedHighlightRange[] {
  const sorted = [...ranges].sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);
  const points = [...new Set(sorted.flatMap((r) => [r.rawStart, r.rawEnd]))].sort((a, b) => a - b);
  const merged: MergedHighlightRange[] = [];

  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    const covering = sorted.filter((r) => r.rawStart < end && r.rawEnd > start);
    if (covering.length === 0) continue;
    const visible = covering.some(isVisible);

    const prev = merged[merged.length - 1];
    const run: MergedHighlightRange =
      prev && prev.rawEnd === start && prev.visible === visible
        ? prev
        : { rawStart: start, rawEnd: end, threads: [], visible };
    if (run !== prev) merged.push(run);
    run.rawEnd = end;
    for (const r of covering) {
      for (const t of r.threads) {
        if (!run.threads.some((seen) => seen.id === t.id)) run.threads.push(t);
      }
    }
  }

  return merged;
}
