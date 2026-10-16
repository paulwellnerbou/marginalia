import { type BlockOccurrence, type BlockSourceRange, canMergeMultiBlock } from './locate-block.js';
import { type SectionContext, scoreSectionMatch } from './section-score.js';

/**
 * What an anchor remembers of the section it was made in. A block id is
 * a content hash, so a line the document repeats carries one id on
 * several blocks, and this is what says which of them the anchor means.
 */
export interface AnchorSection {
  headingPath: readonly string[] | null;
  sectionIndexPath: readonly number[] | null;
}

/**
 * Resolve an anchor (single-block or span) to a source range among every
 * copy of every block. The server splices a proposal into this range and
 * the viewer's proposal composer prefills from it, so both go through
 * here: a composer showing one copy while the server replaces another
 * would duplicate or drop text on accept.
 *
 * `section` picks the start among copies of a repeated block; without it
 * the first copy is taken. A repeated end id resolves to its first copy
 * after the start.
 *
 * Validation goes through `canMergeMultiBlock`:
 *   - `tableCell` endpoints are always rejected (would slice across
 *     `|` pipes).
 *   - `listItem` endpoints are accepted only when both endpoints are
 *     `listItem` AND share the same `parentStart` (same parent list,
 *     same nesting depth). The asciidoc walker doesn't populate
 *     `parentStart` for items, so asciidoc multi-listItem is rejected
 *     here too — this also covers the best-effort
 *     `listItemSourceRange` (no continuation support).
 *   - Cross-depth or cross-list listItem spans, or `listItem` paired
 *     with a different kind, are rejected to avoid splicing across
 *     structural boundaries.
 */
export function locateAnchorSpan(
  occurrences: ReadonlyMap<string, readonly BlockOccurrence[]>,
  blockId: string,
  endBlockId: string | null,
  section: AnchorSection | null,
  format: 'markdown' | 'asciidoc',
): BlockSourceRange | null {
  const startBlock = chooseBySection(occurrences.get(blockId) ?? [], section);
  if (!startBlock) return null;
  if (!endBlockId || endBlockId === blockId) return startBlock;
  const endBlock = chooseSpanEnd(occurrences.get(endBlockId), startBlock);
  if (!endBlock) return null;
  if (!canMergeMultiBlock(startBlock, endBlock, format)) return null;
  return {
    start: Math.min(startBlock.start, endBlock.start),
    end: Math.max(startBlock.end, endBlock.end),
    kind: 'multi',
    text: '',
  };
}

/**
 * The candidate whose section ranks highest against `section`, ties to
 * the first — the same ranking the browser uses to pick the element it
 * highlights. Without a stored section the first is all that can be
 * answered, which is also what a lone candidate gets.
 */
export function chooseBySection<T extends SectionContext>(
  candidates: readonly T[],
  section: AnchorSection | null,
): T | null {
  const first = candidates[0];
  if (first === undefined) return null;
  if (candidates.length === 1 || !section?.headingPath) return first;
  let best = first;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = scoreSectionMatch(candidate, section.headingPath, section.sectionIndexPath);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The end of a span whose end id is repeated: the first copy after the
 * start block, as the browser resolves it. Failing that the last copy
 * before it — the endpoints may arrive in either order, and the min/max
 * merge reads them either way.
 */
function chooseSpanEnd(
  candidates: readonly BlockOccurrence[] | undefined,
  start: BlockOccurrence,
): BlockOccurrence | null {
  if (!candidates || candidates.length === 0) return null;
  return candidates.find((c) => c.start >= start.end) ?? candidates[candidates.length - 1]!;
}
