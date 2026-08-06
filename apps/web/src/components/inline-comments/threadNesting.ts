import { isComment, isProposal, type Thread } from '../../lib/api.js';

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
 * Nesting applies only within the given collection: callers pass the
 * threads that would render together (same list, same orphan bucket),
 * so a proposal whose answered thread renders elsewhere — filtered
 * out, orphaned separately — keeps its standalone card instead of
 * disappearing into a card that isn't there.
 */
export function computeThreadNesting(threads: Thread[]): ThreadNesting {
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
      // Both link directions come from one server column, but the
      // thread array can mix threads fetched at different times (a
      // repaired anchor is spliced into an older list). Require the
      // proposal to name this parent back, so a stale reverse index
      // falls back to the cross-link rendering instead of filing a
      // proposal under a comment it no longer answers.
      if (target.proposal.answers_thread_id !== parent.id) continue;
      nested.push(target);
      parentOf.set(id, parent.id);
    }
    if (nested.length > 0) nestedByParent.set(parent.id, nested);
  }
  const topLevel = parentOf.size === 0 ? threads : threads.filter((t) => !parentOf.has(t.id));
  return { topLevel, nestedByParent, parentOf };
}

/** Nested proposals for one card, or an empty list. */
export function nestedThreadsOf(nesting: ThreadNesting, parentId: string): readonly Thread[] {
  return nesting.nestedByParent.get(parentId) ?? EMPTY_NESTED;
}
