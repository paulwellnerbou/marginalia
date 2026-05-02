import type { BlockSourceRange } from '@marginalia/renderer';
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
 * Validation mirrors the server's `locateAnchorRange`: when `endId` is
 * non-null, neither endpoint may be a `tableCell` (splicing across `|`
 * pipes would corrupt the table). For markdown, `listItem` endpoints
 * are allowed; for asciidoc they're rejected because the asciidoc
 * renderer's per-item source range is single-line / best-effort and
 * doesn't yet cover continuation (`+`) lines, so a multi-listItem
 * splice would truncate items with continuations.
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
  if (!isMultiBlockEndpoint(a.kind, format) || !isMultiBlockEndpoint(b.kind, format)) return null;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

function isMultiBlockEndpoint(kind: string, format: DocumentFormat): boolean {
  if (kind === 'tableCell') return false;
  if (kind === 'listItem' && format === 'asciidoc') return false;
  return true;
}
