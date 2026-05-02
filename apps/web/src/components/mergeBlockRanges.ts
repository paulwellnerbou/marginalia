import { canMergeMultiBlock, type BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat } from '../lib/api.js';

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
 * Validation goes through the renderer's `canMergeMultiBlock`:
 * `tableCell` endpoints are always rejected; `listItem` endpoints are
 * accepted only when both endpoints are `listItem` AND share the same
 * `parentStart` (same parent list, same nesting depth). Asciidoc
 * rejects all listItem multi-block explicitly (predicate's `format`
 * argument), regardless of `parentStart`, because the asciidoc
 * walker's per-item source range is best-effort.
 */
export function mergeBlockRanges(
  ranges: Map<string, BlockSourceRange>,
  startId: string,
  endId: string | null,
  format: DocumentFormat,
): { start: number; end: number } | null {
  const a = ranges.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return { start: a.start, end: a.end };
  const b = ranges.get(endId);
  if (!b) return null;
  if (!canMergeMultiBlock(a, b, format)) return null;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}
