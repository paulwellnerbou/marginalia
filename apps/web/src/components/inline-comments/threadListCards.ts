import { isProposal, proposalStatus, type Thread } from '../../lib/api.js';
import { threadsById } from './inlineUtils.js';
import { cardMatchesFilters, type ThreadCard, type ThreadFilters } from './threadFilters.js';
import { computeThreadNesting, nestedThreadsOf } from './threadNesting.js';

export interface ThreadListCard extends ThreadCard {
  /** Listed under "Orphaned discussions" rather than with the linked threads. */
  isOrphan: boolean;
}

/**
 * The Threads tab's cards before its filters and search.
 *
 * Nesting is bucket-local: a proposal only merges into its answered
 * thread's card when both would render in the same section, so e.g. an
 * orphaned proposal keeps its standalone card under "Orphaned
 * discussions" instead of vanishing into a linked card.
 */
export function buildThreadListCards(threads: Thread[]): {
  cards: ThreadListCard[];
  /** Nested proposal → the card it renders inside. */
  parentOf: Map<string, string>;
} {
  const byId = threadsById(threads);
  const active: Thread[] = [];
  const orphaned: Thread[] = [];
  for (const t of threads) {
    const orphan =
      t.link_status === 'orphaned' && (!isProposal(t) || proposalStatus(t) !== 'accepted');
    if (orphan) orphaned.push(t);
    else active.push(t);
  }
  const parentOf = new Map<string, string>();
  const cards: ThreadListCard[] = [];
  for (const [bucket, isOrphan] of [
    [active, false],
    [orphaned, true],
  ] as const) {
    const nesting = computeThreadNesting(bucket);
    for (const [id, parentId] of nesting.parentOf) parentOf.set(id, parentId);
    for (const t of nesting.topLevel) {
      const nested = nestedThreadsOf(nesting, t.id);
      cards.push({
        thread: t,
        nested,
        // Drawn from every thread, not just this bucket: a reply of the
        // viewer's counts wherever the conversation carried it.
        linked: linkedThreads(t, nested, byId),
        isOrphan,
      });
    }
  }
  return { cards, parentOf };
}

/**
 * The Threads tab's card count while the tab is not mounted to report its
 * own: what it lists when it next opens. That is with the remembered
 * filters and no search — the search box starts empty — plus the one card
 * it will reveal for a focus request it has not honoured yet, which is how
 * a resolved thread opened from Activities is listed.
 */
export function countThreadListCards(
  cards: readonly ThreadListCard[],
  filters: ThreadFilters,
  viewerClientId: string | null,
  revealThreadId: string | null,
): number {
  let count = 0;
  for (const card of cards) {
    const revealed =
      revealThreadId !== null &&
      (card.thread.id === revealThreadId || card.nested.some((n) => n.id === revealThreadId));
    if (revealed || cardMatchesFilters(card, filters, viewerClientId)) count++;
  }
  return count;
}

/**
 * Threads this card's conversation reaches that render elsewhere. A
 * proposal the card already renders inside itself is not a link.
 */
function linkedThreads(
  thread: Thread,
  nested: readonly Thread[],
  byId: Map<string, Thread>,
): Thread[] {
  const inCard = new Set([thread.id, ...nested.map((n) => n.id)]);
  const linked = new Map<string, Thread>();
  for (const source of [thread, ...nested]) {
    const ids = [...source.answered_by_thread_ids, ...(source.proposal?.answers_thread_ids ?? [])];
    for (const id of ids) {
      if (inCard.has(id) || linked.has(id)) continue;
      const target = byId.get(id);
      if (target) linked.set(id, target);
    }
  }
  return [...linked.values()];
}
