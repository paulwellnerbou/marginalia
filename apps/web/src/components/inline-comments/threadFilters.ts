import { type Comment, isProposal, isResolved, type Thread } from '../../lib/api.js';

/** Threads-tab filters. See threadListPrefs for what they start out as. */
export type ThreadStatusFilter = 'all' | 'unresolved';
export type ThreadKindFilter = 'all' | 'proposals';
export type ThreadRepliesFilter = 'all' | 'unanswered';

export interface ThreadFilters {
  status: ThreadStatusFilter;
  kind: ThreadKindFilter;
  replies: ThreadRepliesFilter;
}

/** Filters nothing out — what "clear the filters" resets to. */
export const ALL_THREAD_FILTERS: ThreadFilters = { status: 'all', kind: 'all', replies: 'all' };

/** One card in the list, and the threads its conversation reaches into. */
export interface ThreadCard {
  thread: Thread;
  /** Proposal threads merged into this card, rendered inside it. */
  nested: readonly Thread[];
  /**
   * Threads this card only cross-links to — the proposals answering it
   * that render in someone else's card, and the comments a proposal
   * card answers. They carry cards of their own.
   */
  linked: readonly Thread[];
}

/**
 * Filters one card.
 *
 * 'unresolved' and 'proposals' key off a thread at a time, and the card
 * stays whenever what it renders — its own thread or a proposal nested
 * in it — matches, so "Proposals" still surfaces a proposal that now
 * renders inside the comment it answers. Cross-linked threads have no
 * say here: they are shown by the cards they belong to.
 *
 * 'unanswered' keeps what is waiting on the viewer, identified by
 * client_id — the same identity the server stamps comments with, so a
 * shared display name can't make someone else's reply count as yours.
 * It is judged over the conversation rather than the thread: a reply
 * the viewer left on an answering proposal answers this card too, even
 * though the comment thread's own tail is still the "Addressed in edit
 * proposal …" hand-off.
 */
export function cardMatchesFilters(
  card: ThreadCard,
  filters: ThreadFilters,
  viewerClientId: string | null,
): boolean {
  if (filters.replies === 'unanswered' && viewerHasAnswered(card, viewerClientId)) return false;
  return (
    matchesStatusAndKind(card.thread, filters) ||
    card.nested.some((n) => matchesStatusAndKind(n, filters))
  );
}

function matchesStatusAndKind(thread: Thread, filters: ThreadFilters): boolean {
  if (filters.status === 'unresolved' && isResolved(thread)) return false;
  if (filters.kind === 'proposals' && !isProposal(thread)) return false;
  return true;
}

/**
 * The viewer has spoken later than anyone else has *here*. Their word
 * counts wherever the conversation carried it, but a linked thread's
 * later traffic does not drag this card back into the queue — that
 * thread has a card of its own to be waiting in, and one exchange
 * should be one entry.
 *
 * A tie keeps the card: work is worse missed than listed twice.
 */
function viewerHasAnswered(card: ThreadCard, viewerClientId: string | null): boolean {
  if (!viewerClientId) return false;
  const isViewer = (c: Comment) => c.author.client_id === viewerClientId;
  const isSomeoneElse = (c: Comment) => c.author.client_id !== viewerClientId;
  let mine = Number.NEGATIVE_INFINITY;
  let theirs = Number.NEGATIVE_INFINITY;
  for (const t of [card.thread, ...card.nested]) {
    mine = Math.max(mine, newestWord(t, isViewer));
    theirs = Math.max(theirs, newestWord(t, isSomeoneElse));
  }
  // A linked thread lends the viewer's word, never anyone else's.
  for (const t of card.linked) mine = Math.max(mine, newestWord(t, isViewer));
  return mine > theirs;
}

/** comments are oldest-first, so walk back and stop at the first hit. */
function newestWord(thread: Thread, by: (comment: Comment) => boolean): number {
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    const c = thread.comments[i];
    if (c && by(c)) return c.created_at;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * The filter row's switches, one per axis. Each is a plain on/off: off
 * *is* 'all', which is why the row offers no "All" to pick — turning the
 * switch off already means it.
 */
export interface ThreadFilterToggle {
  /** Doubles as the name of the filter while it is on. */
  label: string;
  /** What turning it on keeps. */
  hint: string;
  isOn: (filters: ThreadFilters) => boolean;
  toggle: (filters: ThreadFilters) => ThreadFilters;
}

export const THREAD_FILTER_TOGGLES: readonly ThreadFilterToggle[] = [
  {
    label: 'Unresolved',
    hint: 'Only threads still open',
    isOn: (f) => f.status === 'unresolved',
    toggle: (f) => ({ ...f, status: f.status === 'unresolved' ? 'all' : 'unresolved' }),
  },
  {
    label: 'Proposals',
    hint: 'Only edit proposals',
    isOn: (f) => f.kind === 'proposals',
    toggle: (f) => ({ ...f, kind: f.kind === 'proposals' ? 'all' : 'proposals' }),
  },
  {
    label: 'Unanswered',
    hint: 'Only threads where someone else had the last word',
    isOn: (f) => f.replies === 'unanswered',
    toggle: (f) => ({ ...f, replies: f.replies === 'unanswered' ? 'all' : 'unanswered' }),
  },
];

/** Names the filters that are narrowing the list. */
export function activeThreadFilterLabels(filters: ThreadFilters): string[] {
  return THREAD_FILTER_TOGGLES.filter((t) => t.isOn(filters)).map((t) => t.label);
}

export function isFilteringThreads(filters: ThreadFilters): boolean {
  return THREAD_FILTER_TOGGLES.some((t) => t.isOn(filters));
}

/**
 * A pasted deep link ("…/d/<uid>#comment-<id>") or bare "#comment-<id>"
 * fragment means the id, not the literal text — the rest of such a URL
 * would match nothing.
 */
export function normalizeThreadSearch(raw: string): string {
  const query = raw.trim();
  const fragment = /#comment-([A-Za-z0-9_-]+)/.exec(query);
  return (fragment ? (fragment[1] as string) : query).toLowerCase();
}

/**
 * Case-insensitive substring match over everything a thread can be known
 * by: its id, each message's id (agents and copied links often name a
 * reply), author names, message bodies, and the anchored quote.
 */
export function threadMatchesSearch(thread: Thread, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const q = normalizedQuery;
  if (thread.id.toLowerCase().includes(q)) return true;
  if (thread.anchor.quote?.toLowerCase().includes(q)) return true;
  return thread.comments.some(
    (c) =>
      c.id.toLowerCase().includes(q) ||
      c.author.display_name.toLowerCase().includes(q) ||
      c.body.toLowerCase().includes(q),
  );
}

/**
 * Whether the list's control row has anything to act on.
 *
 * It has to outlive an empty list: the filters are usually what emptied
 * it, and unmounting them takes away the only way back. `resolvedCount`
 * is the server's whole-document tally, which is what makes that case
 * tellable at all — the archive is not read until something needs it, so
 * a list with nothing in it cannot say on its own whether the document
 * has no comments or only settled ones.
 *
 * A single unfiltered card still gets no row: there is nothing to sort,
 * search or narrow down to.
 */
export function showThreadListControls(args: {
  /** Cards the list holds, before its own filters and search. */
  totalCards: number;
  /** Resolved threads the document has, loaded here or not. */
  resolvedCount: number;
  searching: boolean;
  filters: ThreadFilters;
}): boolean {
  const { totalCards, resolvedCount, searching, filters } = args;
  if (totalCards > 1) return true;
  if (totalCards === 0 && resolvedCount === 0) return false;
  return searching || isFilteringThreads(filters);
}

/** What the list says when it is showing no cards at all. */
export function threadListEmptyMessage(args: {
  totalCards: number;
  resolvedCount: number;
  /** Sections the TOC filter is focused on; 0 = filter off. */
  sectionFilterCount: number;
  searching: boolean;
  filters: ThreadFilters;
  canComment: boolean;
}): string {
  const { totalCards, resolvedCount, sectionFilterCount, searching, filters, canComment } = args;
  // Settled threads count as filtered out even before the archive is
  // read — turning the chip off is what fetches them.
  const filtersHideMore = totalCards > 0 || (resolvedCount > 0 && isFilteringThreads(filters));
  // The section filter is only the reason when nothing else can be. With
  // the archive unread, "none in these sections" is a claim about threads
  // this list has never seen — and clearing the chips may well produce
  // some. The pane's own note says which sections are in focus either way.
  if (totalCards === 0 && sectionFilterCount > 0 && !filtersHideMore) {
    return 'No threads in the focused sections.';
  }
  if (searching) return 'No threads match this search.';
  if (filtersHideMore) return 'No threads match the selected filters.';
  return canComment
    ? 'Select text in the document to comment.'
    : 'You have read-only access to this document.';
}
