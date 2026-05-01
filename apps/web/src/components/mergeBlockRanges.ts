import type { BlockSourceRange } from '@marginalia/renderer';

/**
 * Resolve a (possibly multi-block) source span from the renderer's
 * per-block range map. When `endId` is null/equal to `startId`, returns
 * the start block's offsets. Otherwise returns the merged offsets
 * covering both endpoints in source order. Mirrors `locateBlockRange`
 * in the renderer, but operates on a precomputed map.
 *
 * Returns just `{ start, end }` — callers slice the document source
 * themselves. We deliberately don't return a full `BlockSourceRange`
 * because `text` and `kind` are only meaningful for single blocks; a
 * merged span has no single normalized text.
 *
 * Validation mirrors the server's `locateAnchorRange`: when `endId` is
 * non-null, both endpoints must be top-level blocks (not `listItem` /
 * `tableCell`). A sub-block endpoint would point inside structural
 * markup; the renderer's map contains sub-blocks too, so without this
 * guard the composer / diff could splice mid-row even though the
 * server would treat the same anchor as orphaned.
 */
export function mergeBlockRanges(
  ranges: Map<string, BlockSourceRange>,
  startId: string,
  endId: string | null,
): { start: number; end: number } | null {
  const a = ranges.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return { start: a.start, end: a.end };
  const b = ranges.get(endId);
  if (!b) return null;
  if (!isTopLevelKind(a.kind) || !isTopLevelKind(b.kind)) return null;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

function isTopLevelKind(kind: string): boolean {
  return kind !== 'listItem' && kind !== 'tableCell';
}
