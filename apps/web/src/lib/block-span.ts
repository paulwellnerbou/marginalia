/**
 * Browser-side handling of comment anchors that cover more than one block:
 * which rendered elements a span covers, and how its stored offsets turn
 * into a paintable range.
 *
 * The wire convention (block_id + end_block_id + a `SPAN_SEPARATOR`-joined
 * quote) lives in `@marginalia/renderer`.
 *
 * Only the first and last block ids are stored. The blocks in between are
 * re-derived from the live DOM instead, so a span survives edits that add
 * or remove content inside it — storing every intermediate id would
 * orphan the comment as soon as one of them changed.
 */

import { spanTail } from '@marginalia/renderer';

const COMMENTABLE = '[data-block], [data-subblock]';

/** The subset of an anchor needed to place a highlight. */
export interface HighlightAnchor {
  end_block_id?: string | null;
  quote: string | null;
  start_offset: number | null;
  end_offset: number | null;
}

/**
 * Offsets to paint this anchor's highlight with, or null when there is
 * nothing paintable.
 *
 * `start_offset` indexes the anchor's FIRST block and `end_offset` its
 * LAST, so for a span the two are offsets into different texts and
 * comparing them says nothing — a selection running from late in the
 * first block to early in the last looks inverted. Only a single-block
 * anchor can be rejected that way; a span's endpoints are checked for
 * emptiness per fragment while it is painted.
 *
 * Null offsets come from the server's partial-match reanchor branch: it
 * knows the quote is roughly in this block but not where. Falling back to
 * the fragment's full length lets `resolveNormalizedRange` take its "find
 * the quote anywhere in the block" path instead of dropping the highlight.
 */
export function highlightRange(
  anchor: HighlightAnchor,
): { startOffset: number; endOffset: number } | null {
  const quote = anchor.quote;
  if (!quote) return null;
  const startOffset = anchor.start_offset ?? 0;
  if (anchor.end_block_id) {
    return { startOffset, endOffset: anchor.end_offset ?? spanTail(quote).length };
  }
  const endOffset = anchor.end_offset ?? quote.length;
  return endOffset > startOffset ? { startOffset, endOffset } : null;
}

/** Commentable elements under `root`, in document order. */
export function commentableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(COMMENTABLE));
}

/**
 * Drop elements that contain another element in the list, keeping the
 * innermost. A selection inside one table cell touches both the `<td
 * data-subblock>` and the enclosing `<table data-block>`; the cell is the
 * one a comment should anchor to.
 *
 * `els` must be in document order (parents before descendants), which is
 * what `querySelectorAll` returns — the stack pass relies on it.
 *
 * A nested list item is the one lossy case: keeping the inner `<li>`
 * drops the outer one, so the outer item's own label doesn't reach the
 * quote. Keeping the outer instead would duplicate the inner item's text
 * in the quote, which re-anchoring handles far worse.
 */
export function innermostElements(els: readonly HTMLElement[]): HTMLElement[] {
  const kept: HTMLElement[] = [];
  for (const el of els) {
    while (kept.length > 0 && kept[kept.length - 1]!.contains(el)) kept.pop();
    kept.push(el);
  }
  return kept;
}

/** Innermost commentable elements the range overlaps, in document order. */
export function elementsIntersectingRange(root: HTMLElement, range: Range): HTMLElement[] {
  return innermostElements(commentableElements(root).filter((el) => intersectsRange(range, el)));
}

/**
 * Innermost commentable elements from `startId` through `endId`, inclusive.
 * Returns an empty array when either endpoint is missing from the DOM, so
 * callers can fall back to single-block behavior.
 */
export function spanElements(
  root: HTMLElement,
  startEl: HTMLElement,
  endEl: HTMLElement,
): HTMLElement[] {
  if (startEl === endEl) return [startEl];
  const all = commentableElements(root);
  const a = all.indexOf(startEl);
  const b = all.indexOf(endEl);
  if (a < 0 || b < 0) return [];
  return innermostElements(all.slice(Math.min(a, b), Math.max(a, b) + 1));
}

/** The id a comment anchors to — sub-block when there is one. */
export function anchorIdOf(el: HTMLElement): string | null {
  return el.dataset.subblock ?? el.dataset.block ?? null;
}

export function findAnchorElement(root: HTMLElement, blockId: string): HTMLElement | null {
  const escaped = CSS.escape(blockId);
  return root.querySelector<HTMLElement>(`[data-block="${escaped}"], [data-subblock="${escaped}"]`);
}

function intersectsRange(range: Range, el: HTMLElement): boolean {
  // Range.intersectsNode is non-standard but widely supported.
  if (typeof range.intersectsNode === 'function') return range.intersectsNode(el);

  // Fallback: the standard overlap test, range.start < el.end AND
  // range.end > el.start.
  //
  // `compareBoundaryPoints(how, other)` reads how as <otherPoint>_TO_
  // <thisPoint> — the point named FIRST belongs to `other`, the one
  // named SECOND to the receiver. So END_TO_START compares this.start
  // against other.end, and START_TO_END compares this.end against
  // other.start. Reading the constants the other way round inverts the
  // test into one that is false for every input.
  //
  // Strict inequalities, so touching at a boundary doesn't count. That
  // makes this marginally stricter than intersectsNode, which treats a
  // range ending at `(el, 0)` as intersecting `el` because it compares
  // against el's position in its parent rather than its contents.
  // Either way the caller drops such a block: clamping the range to it
  // yields an empty fragment.
  const elRange = el.ownerDocument.createRange();
  elRange.selectNodeContents(el);
  const startsBeforeElEnd = range.compareBoundaryPoints(Range.END_TO_START, elRange) < 0;
  const endsAfterElStart = range.compareBoundaryPoints(Range.START_TO_END, elRange) > 0;
  return startsBeforeElEnd && endsAfterElStart;
}
