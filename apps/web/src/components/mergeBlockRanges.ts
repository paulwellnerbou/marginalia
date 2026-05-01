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
 * non-null, neither endpoint may be a `tableCell` — a multi-cell span
 * would slice across `|` pipes and corrupt the table. `listItem`
 * endpoints are allowed (line-aligned source ranges splice cleanly), so
 * selecting a subset of items maps to a multi-listItem span.
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
  if (!isMultiBlockEndpoint(a.kind) || !isMultiBlockEndpoint(b.kind)) return null;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

function isMultiBlockEndpoint(kind: string): boolean {
  return kind !== 'tableCell';
}
