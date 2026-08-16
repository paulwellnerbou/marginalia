import { isComment, isProposal, type Thread, type ThreadProposalData } from '../../lib/api.js';

/** Result of joining proposals with the comment threads they answer. */
export interface ThreadNesting {
  /** Threads that keep their own top-level card. */
  topLevel: Thread[];
  /**
   * Proposal threads rendered inside their answered thread's card,
   * keyed by that thread's id. Preserves `answered_by_thread_ids`
   * order (oldest first).
   */
  nestedByParent: Map<string, Thread[]>;
  /** Reverse lookup: nested proposal id → id of the card it renders in. */
  parentOf: Map<string, string>;
}

const EMPTY_NESTED: readonly Thread[] = [];

/**
 * Join each edit proposal with the comment thread it was written to
 * answer, so the pair renders as one merged card instead of two
 * cross-linked ones.
 *
 * One proposal can answer several comments. It merges into exactly one
 * of their cards — repeating the whole card, with its diff and its
 * accept/reject controls, once per answered comment would read as
 * several proposals. The others reach it through the "See proposed
 * change" link they already carry.
 *
 * Nesting applies only within the given collection: callers pass the
 * threads that would render together (same list, same orphan bucket),
 * so a proposal whose answered thread renders elsewhere — filtered
 * out, orphaned separately — keeps its standalone card instead of
 * disappearing into a card that isn't there.
 */
export function computeThreadNesting(threads: Thread[]): ThreadNesting {
  return nest(threads, false);
}

/**
 * `computeThreadNesting` for the presentations that position each card
 * at its thread's anchor — the margin column and the floating popover.
 *
 * There a proposal with an anchor of its own refuses a parent that has
 * none: the merged card renders wherever the *parent* sits, and an
 * unanchored parent sits where unanchored cards go — the foot of the
 * column, the centre of the view — so the proposal would vanish from
 * beside the text it is still highlighting. Flat lists pass through
 * `computeThreadNesting` instead; a card that isn't placed by anchor
 * has nothing to be dragged away from.
 */
export function computeAnchoredThreadNesting(threads: Thread[]): ThreadNesting {
  return nest(threads, true);
}

function nest(threads: Thread[], anchoredPlacement: boolean): ThreadNesting {
  const present = new Map(threads.map((t) => [t.id, t]));
  const nestedByParent = new Map<string, Thread[]>();
  const parentOf = new Map<string, string>();
  for (const parent of threads) {
    // Only comment threads adopt proposals; a proposal never nests
    // under another proposal, so nesting stays one level deep.
    if (!isComment(parent)) continue;
    const nested: Thread[] = [];
    for (const id of parent.answered_by_thread_ids) {
      const target = present.get(id);
      if (!target || !isProposal(target)) continue;
      if (hostOf(target, present, anchoredPlacement) !== parent.id) continue;
      nested.push(target);
      parentOf.set(id, parent.id);
    }
    if (nested.length > 0) nestedByParent.set(parent.id, nested);
  }
  const topLevel = parentOf.size === 0 ? threads : threads.filter((t) => !parentOf.has(t.id));
  return { topLevel, nestedByParent, parentOf };
}

/**
 * The one card a proposal merges into: the first comment it answers
 * that is on screen and able to host it. Oldest answered comment first,
 * the order the server sends — so every view picks the same host, and a
 * proposal cannot be adopted by two cards at once.
 */
function hostOf(
  proposal: Thread & { proposal: ThreadProposalData },
  present: Map<string, Thread>,
  anchoredPlacement: boolean,
): string | null {
  for (const id of proposal.proposal.answers_thread_ids) {
    const parent = present.get(id);
    if (!parent || !isComment(parent)) continue;
    // Both link directions come from one server table, but the thread
    // array can mix threads fetched at different times (a repaired
    // anchor is spliced into an older list). Require the candidate to
    // name the proposal back, so a stale reverse index falls through to
    // the next answered comment — or to the cross-link rendering —
    // instead of filing the proposal under a card that disagrees.
    if (!parent.answered_by_thread_ids.includes(proposal.id)) continue;
    if (anchoredPlacement && proposal.anchor.block_id && !parent.anchor.block_id) continue;
    return parent.id;
  }
  return null;
}

/** Nested proposals for one card, or an empty list. */
export function nestedThreadsOf(nesting: ThreadNesting, parentId: string): readonly Thread[] {
  return nesting.nestedByParent.get(parentId) ?? EMPTY_NESTED;
}
