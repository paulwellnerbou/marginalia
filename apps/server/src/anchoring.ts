import type { BlockInfo } from '@marginalia/renderer';
import type { CommentLinkStatus, CommentRow } from './db.js';

/**
 * Re-anchor a stored comment against a fresh block map.
 *
 * Outcomes (REQUIREMENTS §3.6):
 * - 'linked'          — block with same ID still contains the quote
 * - 'low-confidence'  — quote found elsewhere (different block, or shifted
 *                       within the same block); client should flag for confirmation
 * - 'orphaned'        — no match found; comment preserved but surfaces in
 *                       the orphaned list
 *
 * When the same quote appears in multiple places, we disambiguate using the
 * anchor's stored heading-path and section-index: a candidate block sitting
 * under the same enclosing headings (and close to the same position within
 * that section) wins over a coincidental verbatim match elsewhere.
 *
 * Replies (parent_id !== null) inherit their parent's status — we don't
 * re-anchor them independently.
 */
export interface AnchorUpdate {
  linkStatus: CommentLinkStatus;
  blockId: string | null;
  startOffset: number | null;
  endOffset: number | null;
}

export function reanchor(comment: CommentRow, blocks: BlockInfo[]): AnchorUpdate {
  const quote = comment.anchor_quote;
  if (!quote) {
    return noop(comment);
  }

  const originalPath = parseHeadingPath(comment.anchor_heading_path);
  const originalIndexPath = parseIntArray(comment.anchor_section_index_path);

  const byId = new Map<string, BlockInfo>();
  for (const b of blocks) byId.set(b.id, b);

  // 1. Block with same ID: quote still present? confident.
  const sameBlock = comment.anchor_block_id ? byId.get(comment.anchor_block_id) : undefined;
  if (sameBlock) {
    const idx = sameBlock.text.indexOf(quote);
    if (idx >= 0) {
      return {
        linkStatus: 'linked',
        blockId: sameBlock.id,
        startOffset: idx,
        endOffset: idx + quote.length,
      };
    }
    const partial = longestCommonSubstringLength(sameBlock.text, quote);
    if (partial >= quote.length * 0.7) {
      return {
        linkStatus: 'low-confidence',
        blockId: sameBlock.id,
        startOffset: null,
        endOffset: null,
      };
    }
  }

  // 2. Quote present in one or more other blocks? Pick the candidate with the
  //    strongest heading-path/section-index affinity, not just the first hit.
  const quoteMatches = blocks
    .filter((b) => b.id !== comment.anchor_block_id && b.text.includes(quote))
    .map((b) => ({
      block: b,
      offset: b.text.indexOf(quote),
      score: scoreCandidate(b, originalPath, originalIndexPath),
    }));
  if (quoteMatches.length) {
    quoteMatches.sort((a, b) => b.score - a.score);
    const best = quoteMatches[0]!;
    return {
      linkStatus: 'low-confidence',
      blockId: best.block.id,
      startOffset: best.offset,
      endOffset: best.offset + quote.length,
    };
  }

  // 3. prefix + quote + suffix fuzzy search — again, prefer the structurally
  //    closest candidate.
  const context = (comment.anchor_prefix ?? '') + quote + (comment.anchor_suffix ?? '');
  if (context.length > quote.length) {
    const ctxMatches = blocks
      .filter((b) => b.text.includes(context))
      .map((b) => ({
        block: b,
        offset: b.text.indexOf(context),
        score: scoreCandidate(b, originalPath, originalIndexPath),
      }));
    if (ctxMatches.length) {
      ctxMatches.sort((a, b) => b.score - a.score);
      const best = ctxMatches[0]!;
      const start = best.offset + (comment.anchor_prefix?.length ?? 0);
      return {
        linkStatus: 'low-confidence',
        blockId: best.block.id,
        startOffset: start,
        endOffset: start + quote.length,
      };
    }
  }

  // 4. Orphaned — no match.
  return { linkStatus: 'orphaned', blockId: null, startOffset: null, endOffset: null };
}

function noop(comment: CommentRow): AnchorUpdate {
  return {
    linkStatus: comment.link_status,
    blockId: comment.anchor_block_id,
    startOffset: comment.anchor_start_offset,
    endOffset: comment.anchor_end_offset,
  };
}

/**
 * Rank a candidate block against the comment's original section context.
 *
 * Scoring layers, strongest → weakest:
 *
 *   1. Exact heading-path match (same depth + every segment identical) →
 *      +10_000, then tiebreak by innermost sectionIndex distance.
 *   2. Otherwise, for every shared heading-prefix level k (counting the
 *      implicit root level), +1_000 per level, then subtract the distance
 *      between the candidate's `sectionIndexPath[k]` and the anchor's
 *      stored value. This is the "n-th block under the last known
 *      heading" fallback — if the deepest subheading was renamed away,
 *      we still match position within the nearest surviving parent.
 *   3. No common heading context → score 0 (still better than orphaning,
 *      but any structural signal wins over it).
 *
 * Higher score = more likely the right block.
 */
function scoreCandidate(
  candidate: BlockInfo,
  originalPath: string[] | null,
  originalIndexPath: number[] | null,
): number {
  if (!originalPath) return 0;
  let commonPrefix = 0;
  const maxCommon = Math.min(originalPath.length, candidate.headingPath.length);
  for (let i = 0; i < maxCommon; i++) {
    if (originalPath[i] === candidate.headingPath[i]) commonPrefix++;
    else break;
  }

  // Exact match on the whole path — strongest signal.
  if (
    commonPrefix === originalPath.length &&
    originalPath.length === candidate.headingPath.length
  ) {
    let score = 10_000;
    const lastIdx = originalIndexPath?.[originalIndexPath.length - 1];
    if (lastIdx !== undefined) {
      score -= Math.abs(candidate.sectionIndex - lastIdx);
    }
    return score;
  }

  // Fallback: score by longest shared prefix, then by distance at the
  // deepest common level.  Level k corresponds to sectionIndexPath[k],
  // which counts position within the section rooted at headingPath[0..k-1].
  // k == 0 is the implicit document-root section (works even with no
  // headings at all).
  const deepestCommonLevel = commonPrefix; // 0..originalPath.length
  let score = deepestCommonLevel * 1_000;
  if (originalIndexPath && candidate.sectionIndexPath.length > deepestCommonLevel) {
    const origIdx = originalIndexPath[deepestCommonLevel];
    const candIdx = candidate.sectionIndexPath[deepestCommonLevel];
    if (typeof origIdx === 'number' && typeof candIdx === 'number') {
      score -= Math.abs(candIdx - origIdx);
    }
  }
  return score;
}

function parseHeadingPath(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

function parseIntArray(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : null;
  } catch {
    return null;
  }
}

/**
 * Length of the longest contiguous substring appearing in both inputs.
 * Used as a cheap fuzzy-similarity metric — no diff-match-patch dependency.
 */
function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  let prev = new Array<number>(lb + 1).fill(0);
  let curr = new Array<number>(lb + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : 0;
      if (curr[j]! > best) best = curr[j]!;
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return best;
}
