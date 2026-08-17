import { isProposal, isResolved, type Thread } from '../../lib/api.js';

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

/**
 * Filters one card: a thread plus the proposal threads nested inside
 * it, which render as a single merged unit.
 *
 * 'unresolved' and 'proposals' key off a thread at a time, and the card
 * stays whenever any part of it matches — so "Proposals" still surfaces
 * a proposal that now renders inside the comment it answers.
 *
 * 'unanswered' is judged over the card as a whole: it keeps what is
 * waiting on the viewer, and a reply left on a nested proposal answers
 * the merged conversation even though the comment thread's own tail is
 * still somebody else's. The viewer is identified by client_id — the
 * same identity the server stamps comments with, so a shared display
 * name can't make someone else's reply count as yours.
 */
export function cardMatchesFilters(
  thread: Thread,
  nested: readonly Thread[],
  filters: ThreadFilters,
  viewerClientId: string | null,
): boolean {
  if (filters.replies === 'unanswered' && viewerHadLastWord(thread, nested, viewerClientId)) {
    return false;
  }
  return (
    matchesStatusAndKind(thread, filters) || nested.some((n) => matchesStatusAndKind(n, filters))
  );
}

function matchesStatusAndKind(thread: Thread, filters: ThreadFilters): boolean {
  if (filters.status === 'unresolved' && isResolved(thread)) return false;
  if (filters.kind === 'proposals' && !isProposal(thread)) return false;
  return true;
}

/**
 * comments are oldest-first, so each thread's tail is its latest
 * message; across the card the newest of those tails wins. Ties go to
 * the thread the card is named after, the one the reader sees first.
 */
function viewerHadLastWord(
  thread: Thread,
  nested: readonly Thread[],
  viewerClientId: string | null,
): boolean {
  if (!viewerClientId) return false;
  let latest = thread.comments[thread.comments.length - 1];
  for (const n of nested) {
    const last = n.comments[n.comments.length - 1];
    if (last && (!latest || last.created_at > latest.created_at)) latest = last;
  }
  return latest?.author.client_id === viewerClientId;
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
