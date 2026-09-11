/**
 * Shared resolution of "where does this comment anchor live in the
 * rendered document" — used to paint a thread's highlight, to scroll to it,
 * and to predict where such a scroll would land (toolbar next/prev), so the
 * three can never disagree.
 */

import { type SectionContext, scoreSectionMatch } from '@marginalia/renderer/section-score';
import { closestTopBlock, sectionContextsOf } from './selection.js';

/** What an anchor stores about the section it was made in. */
export interface AnchorSection {
  heading_path?: readonly string[] | null;
  section_index?: number | null;
  section_index_path?: readonly number[] | null;
}

/** Every element carrying `blockId`, in document order. */
export function anchorElements(root: HTMLElement, blockId: string): HTMLElement[] {
  const escaped = CSS.escape(blockId);
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[data-block="${escaped}"], [data-subblock="${escaped}"]`),
  );
}

/**
 * Which of several candidates an anchor means, by section.
 *
 * Ranked the way the server ranks blocks when it re-anchors, so a note is
 * drawn where the server would put it. Ties go to the first — which is all
 * an anchor that stored no section can be given, and is what
 * `querySelector` answers with.
 */
export function chooseBySection<T>(
  candidates: readonly T[],
  sectionOf: (candidate: T) => SectionContext | null,
  section: AnchorSection | null | undefined,
): T | null {
  const first = candidates[0];
  if (first === undefined) return null;
  const path = section?.heading_path;
  if (candidates.length === 1 || !path) return first;
  let best: T = first;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const context = sectionOf(candidate);
    const score = context
      ? scoreSectionMatch(context, path, section.section_index_path ?? null)
      : 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The element a block id names.
 *
 * A block id is a hash of the block's text, so a heading a document repeats
 * — every chapter told from one character's side opening with that name —
 * is one id on several elements, and the anchor's stored section says
 * which. `after` limits the choice to elements following a given one: a
 * span's end block is the first of its id after the start.
 */
export function findAnchorBlock(
  root: HTMLElement,
  blockId: string,
  section?: AnchorSection | null,
  after?: HTMLElement | null,
): HTMLElement | null {
  let candidates = anchorElements(root, blockId);
  if (after) {
    candidates = candidates.filter(
      (el) => (after.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
  }
  if (candidates.length <= 1 || !section?.heading_path) return candidates[0] ?? null;
  // A sub-block's section is its top-level block's, as the anchor recorded it.
  const topOf = new Map<HTMLElement, HTMLElement | null>(
    candidates.map((el) => [el, el.dataset.block ? el : closestTopBlock(el)]),
  );
  const tops = new Set<HTMLElement>();
  for (const top of topOf.values()) if (top) tops.add(top);
  const contexts = sectionContextsOf(root, tops);
  return chooseBySection(
    candidates,
    (el) => {
      const top = topOf.get(el);
      return top ? (contexts.get(top) ?? null) : null;
    },
    section,
  );
}

export function resolveAnchorElement(
  root: HTMLElement,
  blockId: string,
  quote?: string | null,
  section?: AnchorSection | null,
  after?: HTMLElement | null,
): HTMLElement | null {
  const target = findAnchorBlock(root, blockId, section, after);
  if (!target) return null;
  if (!target.dataset.block || !quote) return target;

  // Recovery for comments anchored before sub-block-aware capture
  // landed: their stored block_id points at the enclosing top-level
  // block. If the quote uniquely identifies one sub-block, use that
  // instead of the whole container.
  const subEls = target.querySelectorAll<HTMLElement>('[data-subblock]');
  let narrowed: HTMLElement | null = null;
  let unique = true;
  for (const sub of subEls) {
    const text = (sub.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (!text.includes(quote)) continue;
    if (narrowed) {
      unique = false;
      break;
    }
    narrowed = sub;
  }
  return unique && narrowed ? narrowed : target;
}

/**
 * The element a thread jump scrolls to: the thread's highlight mark
 * when one exists, else the anchor block. Marks list every thread of
 * a merged range in `data-comment-thread-ids`, so threads sharing the
 * same quoted text still resolve to their (shared) mark.
 */
export function resolveThreadScrollTarget(
  root: HTMLElement,
  blockId: string,
  quote?: string | null,
  threadId?: string | null,
  section?: AnchorSection | null,
): HTMLElement | null {
  if (threadId) {
    const mark = root.querySelector<HTMLElement>(
      `mark[data-comment-thread-ids~="${CSS.escape(threadId)}"]`,
    );
    if (mark) return mark;
  }
  return resolveAnchorElement(root, blockId, quote, section);
}
