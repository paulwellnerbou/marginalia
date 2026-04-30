import type { BlockSourceRange } from '@marginalia/renderer';

/**
 * Resolve a (possibly multi-block) source range from the renderer's
 * per-block range map. When `endId` is null/equal to `startId`, returns
 * the start block's range. Otherwise returns the merged range covering
 * both endpoints in source order. Mirrors `locateBlockRange` in the
 * renderer, but operates on a precomputed map.
 */
export function mergeBlockRanges(
  ranges: Map<string, BlockSourceRange>,
  startId: string,
  endId: string | null,
): BlockSourceRange | null {
  const a = ranges.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return a;
  const b = ranges.get(endId);
  if (!b) return null;
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  return { start, end, kind: 'multi', text: '' };
}
