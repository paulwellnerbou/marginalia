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
 * Chars of surviving prefix/suffix agreement that make one occurrence of a
 * quote trustworthy on its own. Both sides are captured 32 chars wide, so
 * this is a modest fraction of an untouched neighbourhood — but far more
 * than a common short word picks up by accident.
 */
const STRONG_CONTEXT = 12;

/** One place `quote` occurs, with how much of the stored context survives there. */
interface Occurrence {
  offset: number;
  context: number;
}

/**
 * Locate one quote fragment, preferring `preferredBlockId`.
 *
 * The quote alone is not evidence of anything: short ones ("it", "that")
 * occur in most blocks of a real document, so every step here weighs the
 * stored prefix/suffix around a candidate occurrence rather than taking
 * the first `indexOf` hit. The ladder is: an unambiguous occurrence in the
 * original block → that block still recognisably holding the quote → the
 * best-supported occurrence anywhere → orphaned when nothing distinguishes
 * the candidates from each other.
 */
function locateFragment(
  ctx: Context,
  quote: string,
  preferredBlockId: string | null,
  context: { prefix: string | null; suffix: string | null },
): FragmentMatch {
  const { blocks, originalPath, originalIndexPath } = ctx;
  const prefix = context.prefix ?? '';
  const suffix = context.suffix ?? '';

  const sameBlock = preferredBlockId ? blocks.find((b) => b.id === preferredBlockId) : undefined;
  const sameHits = sameBlock ? occurrencesOf(sameBlock.text, quote, prefix, suffix) : [];
  const sameBest = sameHits[0];

  const sameBlockHit = (): FragmentMatch => ({
    linkStatus: 'linked',
    blockId: sameBlock!.id,
    startOffset: sameBest!.offset,
    endOffset: sameBest!.offset + quote.length,
  });

  // 1. Same block, and the stored context still surrounds the quote there.
  //    Block ids are content hashes, so a block that kept its id kept its
  //    text: context that agrees nowhere in it means the id is a stale
  //    pointer left by an earlier bad match, not an edited neighbourhood.
  const hasContext = prefix.length > 0 || suffix.length > 0;
  if (sameBlock && sameBest) {
    if (sameBest.context >= STRONG_CONTEXT) return sameBlockHit();
    if (sameHits.length === 1 && (!hasContext || sameBest.context > 0)) return sameBlockHit();
  }

  // 2. Same block, quote gone, but most of it survives there — an edit
  //    inside the quoted range. Keep the comment on the block, unpositioned.
  if (sameBlock && !sameBest) {
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

  // 3. Rank every block holding the quote — including the original one when
  //    its occurrences were ambiguous. Surviving context outranks section
  //    affinity: a matching neighbourhood identifies the spot, while a
  //    section index only narrows it down.
  const candidates: Array<{
    block: BlockInfo;
    hit: Occurrence;
    structural: number;
    preferred: boolean;
  }> = [];
  for (const block of blocks) {
    const hit =
      block.id === sameBlock?.id ? sameBest : occurrencesOf(block.text, quote, prefix, suffix)[0];
    if (!hit) continue;
    candidates.push({
      block,
      hit,
      structural: scoreCandidate(block, originalPath, originalIndexPath),
      preferred: block.id === preferredBlockId,
    });
  }
  candidates.sort(
    (a, b) =>
      b.hit.context - a.hit.context ||
      b.structural - a.structural ||
      Number(b.preferred) - Number(a.preferred),
  );

  // A quote occurring exactly once in the whole document identifies its own
  // spot — there is nothing for it to be confused with, so it stays linked
  // even when nothing recognisable is left around it.
  if (sameBlock && sameBest && sameHits.length === 1 && candidates.length === 1) {
    return sameBlockHit();
  }

  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best) {
    return { linkStatus: 'orphaned', blockId: null, startOffset: null, endOffset: null };
  }

  // A winner only by tie-break is not a winner. When the quote is short and
  // its stored context has been edited away, it matches half the document
  // equally well, and picking one leaves a comment silently attached to
  // unrelated prose. Orphaning says so instead.
  const decisive =
    !runnerUp ||
    best.preferred ||
    best.hit.context >= STRONG_CONTEXT ||
    best.hit.context > runnerUp.hit.context ||
    best.structural > runnerUp.structural;
  if (!decisive) {
    return { linkStatus: 'orphaned', blockId: null, startOffset: null, endOffset: null };
  }

  return {
    linkStatus: 'low-confidence',
    blockId: best.block.id,
    startOffset: best.hit.offset,
    endOffset: best.hit.offset + quote.length,
  };
}

/**
 * Every occurrence of `quote` in `text` that the stored context permits,
 * best-supported first.
 *
 * A quote that stood on its own word boundaries when it was captured has to
 * do so here too — "it" inside "its" is a different word, not a shifted
 * one — which is what keeps one-word anchors from landing mid-word.
 */
function occurrencesOf(text: string, quote: string, prefix: string, suffix: string): Occurrence[] {
  if (!quote) return [];
  const wantsWordBounds = isWordBounded(prefix + quote + suffix, prefix.length, quote.length);
  const out: Occurrence[] = [];
  for (let idx = text.indexOf(quote); idx >= 0; idx = text.indexOf(quote, idx + 1)) {
    if (wantsWordBounds && !isWordBounded(text, idx, quote.length)) continue;
    out.push({ offset: idx, context: contextAgreement(text, idx, quote.length, prefix, suffix) });
  }
  out.sort((a, b) => b.context - a.context);
  return out;
}

/**
 * Chars of stored prefix/suffix still present around `text[idx..idx+len)`.
 *
 * Agreement that is only whitespace counts for nothing: almost every word in
 * the document has a space on either side of it, so a shared space says only
 * that the match is word-shaped, which the word-bound check already covers.
 */
function contextAgreement(
  text: string,
  idx: number,
  len: number,
  prefix: string,
  suffix: string,
): number {
  let back = 0;
  while (back < prefix.length && idx - back > 0 && text[idx - back - 1] === prefix.at(-1 - back)) {
    back++;
  }
  let forward = 0;
  const end = idx + len;
  while (forward < suffix.length && text[end + forward] === suffix[forward]) forward++;
  return (
    substantial(prefix.slice(prefix.length - back), back) +
    substantial(suffix.slice(0, forward), forward)
  );
}

function substantial(matched: string, length: number): number {
  return matched.trim().length > 0 ? length : 0;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Does `text[idx..idx+len)` begin and end on word boundaries? */
function isWordBounded(text: string, idx: number, len: number): boolean {
  const first = text[idx];
  const last = text[idx + len - 1];
  const before = text[idx - 1];
  const after = text[idx + len];
  if (first && before && WORD_CHAR.test(first) && WORD_CHAR.test(before)) return false;
  if (last && after && WORD_CHAR.test(last) && WORD_CHAR.test(after)) return false;
  return true;
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
  // Stored paths may sit deeper in the tree than they claim: a client that
  // captured before an outer heading existed (or before it was part of the
  // walk) recorded only the inner levels. Try every alignment of the stored
  // path against the candidate's and keep the best — offset 0 is the plain
  // left-aligned comparison, so nothing that used to match stops matching.
  let best = 0;
  const maxOffset = Math.max(0, candidate.headingPath.length - originalPath.length);
  for (let offset = 0; offset <= maxOffset; offset++) {
    const score = scoreAlignment(candidate, originalPath, originalIndexPath, offset);
    if (score > best) best = score;
  }
  return best;
}

function scoreAlignment(
  candidate: BlockInfo,
  originalPath: string[],
  originalIndexPath: number[] | null,
  offset: number,
): number {
  let commonPrefix = 0;
  const maxCommon = Math.min(originalPath.length, candidate.headingPath.length - offset);
  for (let i = 0; i < maxCommon; i++) {
    if (headingSegmentsMatch(originalPath[i]!, candidate.headingPath[offset + i]!)) commonPrefix++;
    else break;
  }

  // Exact match on the whole path — strongest signal.
  if (
    commonPrefix === originalPath.length &&
    originalPath.length === candidate.headingPath.length - offset
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
  if (originalIndexPath && candidate.sectionIndexPath.length > deepestCommonLevel + offset) {
    const origIdx = originalIndexPath[deepestCommonLevel];
    const candIdx = candidate.sectionIndexPath[deepestCommonLevel + offset];
    if (typeof origIdx === 'number' && typeof candIdx === 'number') {
      score -= Math.abs(candIdx - origIdx);
    }
  }
  return score;
}

/**
 * Heading paths captured from the DOM used to include the rehype `#`
 * permalink sigil that gets grafted into every heading, so a stored
 * `"#Chapter 4"` describes the same heading as the block map's
 * `"Chapter 4"`. Exactly one leading `#` is discounted — a heading whose
 * text genuinely starts with `#` stored two of them.
 */
function headingSegmentsMatch(stored: string, candidate: string): boolean {
  return stored === candidate || stored === `#${candidate}`;
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
