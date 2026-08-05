import { type BlockInfo, splitSpanQuote } from '@marginalia/renderer';
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
  /** Last block of a multi-block span; null once the anchor covers one block. */
  endBlockId: string | null;
  startOffset: number | null;
  endOffset: number | null;
  /**
   * Rewritten quote, or null to keep the stored one. Only set when a span
   * collapses and the surviving fragments no longer match what was stored.
   */
  quote: string | null;
}

/**
 * Every anchored root comment in a document, flagged with whether it is an
 * edit proposal — proposals re-anchor under different rules, see
 * `ReanchorOptions.isEditProposal`.
 */
export const TOP_LEVEL_COMMENTS_SQL = `
  SELECT c.*, (cep.comment_id IS NOT NULL) AS is_edit_proposal
    FROM comments c
    LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
   WHERE c.doc_uid = ? AND c.parent_id IS NULL AND c.deleted_at IS NULL`;

export type TopLevelCommentRow = CommentRow & { is_edit_proposal: number };

/**
 * Statement every re-anchoring pass writes through. `anchor_quote` is only
 * overwritten when the update carries a rewritten one — a collapsed span —
 * so the common case leaves the stored quote untouched.
 */
export const REANCHOR_COMMENT_SQL = `
  UPDATE comments
     SET anchor_block_id = ?,
         anchor_end_block_id = ?,
         anchor_start_offset = ?,
         anchor_end_offset = ?,
         anchor_quote = COALESCE(?, anchor_quote),
         link_status = ?,
         updated_at = ?
   WHERE id = ?`;

export function reanchorParams(
  upd: AnchorUpdate,
  now: number,
  commentId: string,
): [
  string | null,
  string | null,
  number | null,
  number | null,
  string | null,
  string,
  number,
  string,
] {
  return [
    upd.blockId,
    upd.endBlockId,
    upd.startOffset,
    upd.endOffset,
    upd.quote,
    upd.linkStatus,
    now,
    commentId,
  ];
}

export interface ReanchorOptions {
  /**
   * Edit proposals also carry `anchor_end_block_id`, but their quote is a
   * snapshot of the spliced source rather than a per-block fragment list,
   * and `reanchorProposals` owns their span endpoints. Re-anchoring one
   * here must never collapse or rewrite that span, so proposals opt out.
   */
  isEditProposal?: boolean;
}

export function reanchor(
  comment: CommentRow,
  blocks: BlockInfo[],
  options: ReanchorOptions = {},
): AnchorUpdate {
  const quote = comment.anchor_quote;
  if (!quote) {
    return noop(comment);
  }

  const originalPath = parseHeadingPath(comment.anchor_heading_path);
  const originalIndexPath = parseIntArray(comment.anchor_section_index_path);
  const ctx: Context = { comment, blocks, originalPath, originalIndexPath };

  const fragments = splitSpanQuote(quote);
  if (!options.isEditProposal && comment.anchor_end_block_id && fragments.length > 1) {
    return reanchorSpan(ctx, fragments);
  }
  const found = locateFragment(ctx, quote, comment.anchor_block_id, {
    prefix: comment.anchor_prefix,
    suffix: comment.anchor_suffix,
  });
  return {
    ...found,
    endBlockId: options.isEditProposal ? comment.anchor_end_block_id : null,
    quote: null,
  };
}

interface Context {
  comment: CommentRow;
  blocks: BlockInfo[];
  originalPath: string[] | null;
  originalIndexPath: number[] | null;
}

interface FragmentMatch {
  linkStatus: CommentLinkStatus;
  blockId: string | null;
  startOffset: number | null;
  endOffset: number | null;
}

/**
 * Re-anchor a span by re-anchoring its two endpoints independently: the
 * leading fragment against `anchor_block_id`, the trailing one against
 * `anchor_end_block_id`. The fragments in between are not stored — the
 * client re-derives them from the DOM — so content edited inside the span
 * doesn't weaken the anchor.
 *
 * A span survives as a span only while both endpoints resolve and stay in
 * document order. Otherwise it collapses to whichever endpoint is left,
 * and the quote is rewritten to that endpoint's fragment so `block_id`
 * and the leading fragment stay in sync for every downstream reader.
 */
function reanchorSpan(ctx: Context, fragments: string[]): AnchorUpdate {
  const head = fragments[0]!;
  const tail = fragments[fragments.length - 1]!;
  // The stored prefix sits before the head and the suffix after the tail;
  // neither endpoint gets to use the other's context.
  const start = locateFragment(ctx, head, ctx.comment.anchor_block_id, {
    prefix: ctx.comment.anchor_prefix,
    suffix: null,
  });
  const end = locateFragment(ctx, tail, ctx.comment.anchor_end_block_id, {
    prefix: null,
    suffix: ctx.comment.anchor_suffix,
  });

  if (start.linkStatus === 'orphaned') {
    // Leading block gone: keep the comment on the surviving tail rather
    // than orphaning the whole thread, but it is no longer a span.
    if (end.linkStatus === 'orphaned') {
      return {
        linkStatus: 'orphaned',
        blockId: null,
        endBlockId: null,
        startOffset: null,
        endOffset: null,
        quote: null,
      };
    }
    return { ...end, linkStatus: 'low-confidence', endBlockId: null, quote: tail };
  }
  if (end.linkStatus === 'orphaned') {
    return { ...start, linkStatus: 'low-confidence', endBlockId: null, quote: head };
  }

  // Both endpoints found, but an edit may have reordered them (or moved
  // one into the other's block). A span that no longer runs forwards
  // can't be painted, so keep only its head.
  const startIdx = ctx.blocks.findIndex((b) => b.id === start.blockId);
  const endIdx = ctx.blocks.findIndex((b) => b.id === end.blockId);
  if (start.blockId === end.blockId || startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return { ...start, linkStatus: 'low-confidence', endBlockId: null, quote: head };
  }

  return {
    linkStatus:
      start.linkStatus === 'linked' && end.linkStatus === 'linked' ? 'linked' : 'low-confidence',
    blockId: start.blockId,
    endBlockId: end.blockId,
    startOffset: start.startOffset,
    endOffset: end.endOffset,
    // Middle fragments are never read back — the client re-derives the
    // blocks between the endpoints from the DOM — so leave the stored
    // quote alone even when the span's interior changed.
    quote: null,
  };
}

/**
 * Locate one quote fragment, preferring `preferredBlockId`. This is the
 * original single-block ladder: same block → same block fuzzily → the
 * best-scoring other block containing it → prefix+quote+suffix.
 */
function locateFragment(
  ctx: Context,
  quote: string,
  preferredBlockId: string | null,
  context: { prefix: string | null; suffix: string | null },
): FragmentMatch {
  const { blocks, originalPath, originalIndexPath } = ctx;

  // 1. Block with same ID: quote still present? confident.
  const sameBlock = preferredBlockId ? blocks.find((b) => b.id === preferredBlockId) : undefined;
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
    .filter((b) => b.id !== preferredBlockId && b.text.includes(quote))
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
  const prefix = context.prefix ?? '';
  const needle = prefix + quote + (context.suffix ?? '');
  if (needle.length > quote.length) {
    const ctxMatches = blocks
      .filter((b) => b.text.includes(needle))
      .map((b) => ({
        block: b,
        offset: b.text.indexOf(needle),
        score: scoreCandidate(b, originalPath, originalIndexPath),
      }));
    if (ctxMatches.length) {
      ctxMatches.sort((a, b) => b.score - a.score);
      const best = ctxMatches[0]!;
      const start = best.offset + prefix.length;
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
    endBlockId: comment.anchor_end_block_id,
    startOffset: comment.anchor_start_offset,
    endOffset: comment.anchor_end_offset,
    quote: null,
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
