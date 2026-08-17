import { type BlockInfo, type BlockSourceRange, splitSpanQuote } from '@marginalia/renderer';
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

/**
 * Whether re-anchoring left the comment exactly where it was.
 *
 * Most edits move nothing: accepting one proposal re-runs `reanchor` over
 * every root comment in the document, and the overwhelming majority resolve
 * to the anchor they already had. Writing those rows anyway bumps
 * `updated_at` on each one, which makes them look changed to every client —
 * a full thread list then differs only by timestamps, and the viewer
 * re-renders every card for nothing.
 *
 * Mirrors REANCHOR_COMMENT_SQL, including its `COALESCE` on the quote:
 * a null `quote` means "keep the stored one", so it is never a change.
 */
export function anchorUnchanged(comment: CommentRow, upd: AnchorUpdate): boolean {
  return (
    upd.blockId === comment.anchor_block_id &&
    upd.endBlockId === comment.anchor_end_block_id &&
    upd.startOffset === comment.anchor_start_offset &&
    upd.endOffset === comment.anchor_end_offset &&
    upd.linkStatus === comment.link_status &&
    (upd.quote === null || upd.quote === comment.anchor_quote)
  );
}

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
   *
   * They also opt out of the elementless-block filter below: a proposal
   * is applied by splicing the block's *source* range, which
   * `locateAllBlocks` resolves for raw HTML and frontmatter as readily as
   * for a paragraph. Orphaning one for want of an element would make an
   * otherwise applicable proposal unacceptable (threads.ts refuses to
   * diff or accept an orphan), which is a worse outcome than a card that
   * renders without a highlight to sit next to.
   */
  isEditProposal?: boolean;
  /** Replacement evidence prepared once for every comment in this edit. */
  blockReplacements?: ReadonlyMap<string, string>;
}

export interface BlockTransition {
  before: ReadonlyMap<string, BlockSourceRange>;
  after: ReadonlyMap<string, BlockSourceRange>;
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
  // Blocks the renderer never gave an element to are not candidates for a
  // comment. Their text is real — raw HTML, frontmatter, a mermaid
  // diagram's source — so a quote can match one as readily as any
  // paragraph, but the id we would store is one no client can resolve:
  // `resolveAnchorElement` finds nothing and the comment's highlight
  // silently never appears. Orphaning says so; a dead id doesn't.
  const ctx: Context = {
    comment,
    blocks: options.isEditProposal ? blocks : blocks.filter((b) => b.anchorable),
    originalPath,
    originalIndexPath,
    replacements: options.isEditProposal ? new Map() : (options.blockReplacements ?? new Map()),
  };

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
  /** Old content-hash id -> block that replaced it in this exact edit. */
  replacements: ReadonlyMap<string, string>;
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
 * Word characters of surviving prefix/suffix agreement that make one
 * occurrence of a quote trustworthy on its own. Both sides are captured 32
 * chars wide. Spaces and dialogue punctuation carry almost no identifying
 * information, and counting them let `ing," Maeve ` reach the old 12-char
 * threshold and launder an unrelated occurrence of "says" as linked.
 */
const STRONG_CONTEXT = 12;

/** One place `quote` occurs, with how much of the stored context survives there. */
interface Occurrence {
  offset: number;
  context: number;
  /** Every stored context character that could agree here did. */
  complete: boolean;
  /** One meaningful stored side agreed completely (the quote is near an edge). */
  edgeComplete: boolean;
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

  const hasContext = prefix.length > 0 || suffix.length > 0;

  /**
   * Does the context surviving at this occurrence identify it, rather than
   * merely fail to rule it out?
   *
   * Either enough of the neighbourhood survives that coincidence is
   * implausible, or all of it does — a quote near the edge of its block
   * stores only the few chars that fit, and those agreeing everywhere they
   * can is the most that anchor will ever offer. Partial agreement earns
   * nothing: the filler between content words (" the ", " and ") repeats in
   * every paragraph of a real document, so a handful of chars is what a
   * wrong block looks like, not a weak version of the right one.
   */
  const vouched = (hit: Occurrence): boolean =>
    hasContext && (hit.context >= STRONG_CONTEXT || hit.complete || hit.edgeComplete);

  // A content edit gives us evidence quote search can never recover: the
  // before/after block walks show that this old hash was replaced at the same
  // position between the same stable neighbours. Follow that paragraph even
  // when the selected word itself was deleted. It stays low-confidence and
  // unpositioned because the transition identifies the block, not an exact
  // range inside its new text.
  const replacementId = preferredBlockId ? ctx.replacements.get(preferredBlockId) : undefined;
  const replacement = replacementId ? blocks.find((b) => b.id === replacementId) : undefined;
  if (replacement) {
    const hits = occurrencesOf(replacement.text, quote, prefix, suffix);
    const best = hits[0];
    const runnerUp = hits[1];
    // The transition identifies the rewritten block. Preserve an exact range
    // as well when the quote is unique there, or when its surviving context
    // distinguishes one repeated occurrence. Otherwise keep the conservative
    // block-only anchor below rather than choosing an arbitrary repetition.
    if (
      best &&
      (!runnerUp || (vouched(best) && (!vouched(runnerUp) || best.context > runnerUp.context)))
    ) {
      return {
        linkStatus: 'low-confidence',
        blockId: replacement.id,
        startOffset: best.offset,
        endOffset: best.offset + quote.length,
      };
    }
    return {
      linkStatus: 'low-confidence',
      blockId: replacement.id,
      startOffset: null,
      endOffset: null,
    };
  }

  const sameBlock = preferredBlockId ? blocks.find((b) => b.id === preferredBlockId) : undefined;
  const sameHits = sameBlock ? occurrencesOf(sameBlock.text, quote, prefix, suffix) : [];
  const sameBest = sameHits[0];

  const sameBlockHit = (): FragmentMatch => ({
    linkStatus: 'linked',
    blockId: sameBlock!.id,
    startOffset: sameBest!.offset,
    endOffset: sameBest!.offset + quote.length,
  });

  // 1. Same block, and the stored context still vouches for the quote there.
  //    Block ids are content hashes, so a block that kept its id kept its
  //    text: an anchor genuinely captured on it agrees with every context
  //    char it stored. Anything less means the id is a stale pointer left by
  //    an earlier bad match, not an edited neighbourhood — and promoting that
  //    to 'linked' is how one bad guess becomes indistinguishable from an
  //    anchor nobody ever doubted.
  if (sameBlock && sameBest) {
    if (vouched(sameBest)) return sameBlockHit();
    if (!hasContext && sameHits.length === 1) return sameBlockHit();
  }

  // A prior exact edit transition deliberately left this anchor on the
  // replacement block without claiming an exact range. Keep that flagged
  // block-only anchor stable on later saves; otherwise the still-stored short
  // quote would immediately start another document-wide search.
  if (
    sameBlock &&
    ctx.comment.link_status === 'low-confidence' &&
    ctx.comment.anchor_start_offset === null &&
    ctx.comment.anchor_end_offset === null
  ) {
    return {
      linkStatus: 'low-confidence',
      blockId: sameBlock.id,
      startOffset: null,
      endOffset: null,
    };
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
  //    its occurrences were ambiguous. A vouched-for neighbourhood outranks
  //    section affinity, which in turn outranks context too partial to be
  //    worth anything: agreement that identifies the spot beats one that
  //    narrows it down, but a chapter away is a worse guess than the section
  //    the comment was written in, however many stray chars line up there.
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
      Number(vouched(b.hit)) - Number(vouched(a.hit)) ||
      b.structural - a.structural ||
      b.hit.context - a.hit.context ||
      Number(b.preferred) - Number(a.preferred),
  );

  // A quote occurring exactly once in the whole document identifies its own
  // spot, so the block it was already anchored to keeps it linked even when
  // nothing recognisable is left around it. Uniqueness alone is not enough
  // to hand a comment to a block it was never on: `linked` means the stored
  // block still holds the quote (§3.6), and a quote that turned up somewhere
  // else is a comment sitting on text nobody attached it to. That stays
  // low-confidence however distinctive it is.
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
  //
  // The original block is the one exception, on the grounds that its id came
  // from somewhere — but only while there was no stored context to test it
  // against. Context that was testable and did not vouch for it is exactly
  // what a stale id looks like, so that case orphans like any other.
  const preferredUntested = best.preferred && !hasContext;
  const decisive =
    !runnerUp ||
    preferredUntested ||
    best.structural > runnerUp.structural ||
    (vouched(best.hit) && (!vouched(runnerUp.hit) || best.hit.context > runnerUp.hit.context));
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
 *
 * Only the leading occurrence is ever read back, so `complete` breaks ties:
 * a context window that is entirely whitespace scores zero however much of
 * it agrees, and an intact occurrence that lost the tie would look partial
 * to every caller that asks whether the context vouches for it.
 */
function occurrencesOf(text: string, quote: string, prefix: string, suffix: string): Occurrence[] {
  if (!quote) return [];
  const wantsWordBounds = isWordBounded(prefix + quote + suffix, prefix.length, quote.length);
  const out: Occurrence[] = [];
  for (let idx = text.indexOf(quote); idx >= 0; idx = text.indexOf(quote, idx + 1)) {
    if (wantsWordBounds && !isWordBounded(text, idx, quote.length)) continue;
    out.push({ offset: idx, ...contextAgreement(text, idx, quote.length, prefix, suffix) });
  }
  out.sort(
    (a, b) =>
      b.context - a.context ||
      Number(b.complete) - Number(a.complete) ||
      Number(b.edgeComplete) - Number(a.edgeComplete),
  );
  return out;
}

/**
 * Chars of stored prefix/suffix still present around `text[idx..idx+len)`,
 * and whether that is all of them.
 *
 * Agreement that is only whitespace counts for nothing: almost every word in
 * the document has a space on either side of it, so a shared space says only
 * that the match is word-shaped, which the word-bound check already covers.
 * `complete` is judged on the raw run lengths rather than that score, so a
 * short context that happens to be whitespace still reads as intact.
 */
function contextAgreement(
  text: string,
  idx: number,
  len: number,
  prefix: string,
  suffix: string,
): { context: number; complete: boolean; edgeComplete: boolean } {
  let back = 0;
  while (back < prefix.length && idx - back > 0 && text[idx - back - 1] === prefix.at(-1 - back)) {
    back++;
  }
  let forward = 0;
  const end = idx + len;
  while (forward < suffix.length && text[end + forward] === suffix[forward]) forward++;
  const matchedPrefix = prefix.slice(prefix.length - back);
  const matchedSuffix = suffix.slice(0, forward);
  return {
    context: substantial(matchedPrefix, back) + substantial(matchedSuffix, forward),
    complete: back === prefix.length && forward === suffix.length,
    // Selection capture has less than 32 characters on a side only when the
    // quote sits near that block edge. In that case a whole meaningful side
    // is the strongest evidence the anchor can provide even if the other
    // side was edited. Punctuation alone (notably a shared period) does not
    // qualify; four word characters is enough for `Maeve `, but not ` the `.
    edgeComplete:
      (prefix.length > 0 &&
        prefix.length < 32 &&
        back === prefix.length &&
        substantial(matchedPrefix, back) >= 4) ||
      (suffix.length > 0 &&
        suffix.length < 32 &&
        forward === suffix.length &&
        substantial(matchedSuffix, forward) >= 4),
  };
}

function substantial(matched: string, length: number): number {
  if (length === 0) return 0;
  let wordChars = 0;
  for (const char of matched) {
    if (WORD_CHAR.test(char)) wordChars++;
  }
  return wordChars;
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

/**
 * Map blocks replaced by the edit represented by `transition`.
 *
 * Stable content-hash ids on either side delimit edit hunks. Inside a hunk we
 * map by position when the old and new block counts are equal and the paired
 * kinds agree. Unequal hunks get a second, conservative mutual-similarity
 * pass. Ambiguous rewrites, splits, joins, and structurally different blocks
 * remain unmapped and fall back to the quote matcher.
 */
export function prepareBlockReplacements(
  transition: BlockTransition | undefined,
): ReadonlyMap<string, string> {
  const replacements = new Map<string, string>();
  if (!transition) return replacements;

  const before = Array.from(transition.before.entries());
  const after = Array.from(transition.after.entries());
  const afterIndex = new Map(after.map(([id], index) => [id, index]));

  let beforeCursor = 0;
  let afterCursor = 0;
  while (beforeCursor < before.length || afterCursor < after.length) {
    const beforeId = before[beforeCursor]?.[0];
    const afterId = after[afterCursor]?.[0];
    if (beforeId !== undefined && beforeId === afterId) {
      beforeCursor++;
      afterCursor++;
      continue;
    }

    let nextBefore = beforeCursor;
    let nextAfter = afterCursor;
    let foundBoundary = false;
    for (; nextBefore < before.length; nextBefore++) {
      const candidateAfter = afterIndex.get(before[nextBefore]![0]);
      if (candidateAfter !== undefined && candidateAfter >= afterCursor) {
        nextAfter = candidateAfter;
        foundBoundary = true;
        break;
      }
    }
    if (!foundBoundary) {
      nextBefore = before.length;
      nextAfter = after.length;
    }

    const oldHunk = before.slice(beforeCursor, nextBefore);
    const newHunk = after.slice(afterCursor, nextAfter);
    if (oldHunk.length === newHunk.length) {
      for (let i = 0; i < oldHunk.length; i++) {
        const [oldId, oldBlock] = oldHunk[i]!;
        const [newId, newBlock] = newHunk[i]!;
        if (oldBlock.kind === newBlock.kind) replacements.set(oldId, newId);
      }
    } else {
      mapSimilarHunkBlocks(oldHunk, newHunk, replacements);
    }

    beforeCursor = nextBefore;
    afterCursor = nextAfter;
  }
  return replacements;
}

/**
 * Map recognisably rewritten blocks inside an unequal-sized edit hunk.
 *
 * A proposal often changes one paragraph and deletes an adjacent one, so
 * stable-neighbour alignment alone yields (say) three old blocks versus two
 * new blocks. Pair only mutual best matches with substantial token overlap
 * and a clear margin over their runner-up. This recovers the rewritten
 * paragraph without pretending to understand splits, joins, or repeated
 * boilerplate.
 */
function mapSimilarHunkBlocks(
  oldHunk: Array<[string, BlockSourceRange]>,
  newHunk: Array<[string, BlockSourceRange]>,
  replacements: Map<string, string>,
): void {
  // A wholesale rewrite with no stable interior boundaries can make this
  // hunk enormous. Similarity is only a conservative refinement, never a
  // reason to spend quadratic work on the entire document.
  if (oldHunk.length * newHunk.length > 10_000) return;

  const oldBags = oldHunk.map(([, block]) => wordBagOf(block.text));
  const newBags = newHunk.map(([, block]) => wordBagOf(block.text));
  const scores = oldHunk.map(([, oldBlock], oldIndex) =>
    newHunk.map(([, newBlock], newIndex) =>
      oldBlock.kind === newBlock.kind
        ? blockTextSimilarity(oldBags[oldIndex]!, newBags[newIndex]!)
        : 0,
    ),
  );

  const bestNewForOld = scores.map((row) => bestDistinctScore(row));
  const bestOldForNew = newHunk.map((_, newIndex) =>
    bestDistinctScore(scores.map((row) => row[newIndex] ?? 0)),
  );

  for (let oldIndex = 0; oldIndex < oldHunk.length; oldIndex++) {
    const oldBest = bestNewForOld[oldIndex];
    if (!oldBest || oldBest.score < 0.5 || oldBest.score - oldBest.runnerUp < 0.15) continue;
    const newBest = bestOldForNew[oldBest.index];
    if (!newBest || newBest.index !== oldIndex || newBest.score - newBest.runnerUp < 0.15) {
      continue;
    }
    const old = oldHunk[oldIndex];
    const replacement = newHunk[oldBest.index];
    if (old && replacement) replacements.set(old[0], replacement[0]);
  }
}

function bestDistinctScore(values: number[]): { index: number; score: number; runnerUp: number } {
  let index = -1;
  let score = 0;
  let runnerUp = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    if (value > score) {
      runnerUp = score;
      score = value;
      index = i;
    } else if (value > runnerUp) {
      runnerUp = value;
    }
  }
  return { index, score, runnerUp };
}

interface WordBag {
  size: number;
  counts: Map<string, number>;
}

/** Sørensen-Dice overlap of word multisets; repeated prose counts repeatedly. */
function blockTextSimilarity(a: WordBag, b: WordBag): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] =
    a.counts.size <= b.counts.size ? [a.counts, b.counts] : [b.counts, a.counts];
  let intersection = 0;
  for (const [word, count] of smaller) {
    intersection += Math.min(count, larger.get(word) ?? 0);
  }
  return (2 * intersection) / (a.size + b.size);
}

function wordBagOf(text: string): WordBag {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return { size: words.length, counts };
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
