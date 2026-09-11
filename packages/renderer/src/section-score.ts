/**
 * Ranking a block against the section context a comment anchor stores: the
 * enclosing heading texts and the block's position at each level.
 *
 * A block id is a content hash, so a heading a document repeats — a novel
 * opening every chapter told from one character's side with that name — is
 * one id on several blocks, and one quote can sit verbatim in several
 * sections. The section context is what tells them apart, and every reader
 * of an anchor has to rank candidates by it the same way: the server when
 * it re-anchors after an edit, the browser when it draws a highlight on one
 * of several elements carrying the anchor's id.
 */

/** The section a block sits in, as the block map records it. */
export interface SectionContext {
  /** Enclosing heading texts, outermost first; a heading's own path ends with itself. */
  headingPath: readonly string[];
  /** Position within the innermost section. */
  sectionIndex: number;
  /** Position within the section at each level, root first — one more entry than headings. */
  sectionIndexPath: readonly number[];
}

/**
 * Rank a candidate block against an anchor's original section context.
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
export function scoreSectionMatch(
  candidate: SectionContext,
  originalPath: readonly string[] | null,
  originalIndexPath: readonly number[] | null,
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
  candidate: SectionContext,
  originalPath: readonly string[],
  originalIndexPath: readonly number[] | null,
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
export function headingSegmentsMatch(stored: string, candidate: string): boolean {
  return stored === candidate || stored === `#${candidate}`;
}
