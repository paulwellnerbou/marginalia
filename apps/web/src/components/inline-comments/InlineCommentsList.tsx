import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import {
  ClockIcon,
  Cross2Icon,
  DotsHorizontalIcon,
  MagnifyingGlassIcon,
  TextAlignLeftIcon,
} from '@radix-ui/react-icons';
import { Button, DropdownMenu, IconButton, Text, TextField } from '@radix-ui/themes';
import { ArrowUpDownIcon, FunnelIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';
import { getClientId } from '../../lib/identity.js';
import {
  buildThreadCollapseState,
  reconcileThreadCollapseState,
  type ThreadCollapseState,
} from '../threadCollapseState.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import { type ThreadActionResult, threadLinks, threadsById } from './inlineUtils.js';
import {
  ALL_THREAD_FILTERS,
  cardMatchesFilters,
  isFilteringThreads,
  normalizeThreadSearch,
  THREAD_FILTER_TOGGLES,
  type ThreadCard,
  type ThreadFilters,
  threadMatchesSearch,
} from './threadFilters.js';
import {
  loadThreadFilters,
  loadThreadSortMode,
  saveThreadFilters,
  saveThreadSortMode,
  type ThreadSortMode,
} from './threadListPrefs.js';
import { computeThreadNesting, nestedThreadsOf } from './threadNesting.js';
import { type ThreadRefApi, threadRefIndex } from './threadRefs.js';
import {
  DEFAULT_ROW_ESTIMATE,
  useIsomorphicLayoutEffect,
  useWindowedList,
} from './useWindowedList.js';

/**
 * Right-pane list of comment threads using the same inline-comment
 * cards as the document column, but laid out as a flat vertical list
 * (no sticky/anchored positioning, no scroll coupling). Sortable
 * between document order and latest activity.
 *
 * Replaces the legacy CommentsPane / ThreadItem / CommentItem /
 * DiscussionUi stack — the cards from inline-comments/ are now the
 * single source of truth for thread rendering.
 *
 * Reading surface only: a new comment is always composed over the
 * document, in the margin column or as a popover at the selection, so
 * this pane never hosts the new-comment form. Reply composers inside
 * the cards are unaffected.
 */
interface Props {
  uid: string;
  threads: Thread[];
  /** True until the document's first thread read settles. */
  loading?: boolean;
  /** Reports the number of cards left after this tab's filters and search. */
  onVisibleCountChange: (count: number) => void;
  /** Number of sections the TOC's section filter is focused on; 0 = filter off. */
  sectionFilterCount?: number;
  onClearSectionFilter?: () => void;
  blockRanges: Map<string, BlockSourceRange>;
  canComment: boolean;
  focusedThread: { threadId: string; nonce: number } | null;
  displayName: string | null;
  mentionCandidates: string[];
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSetHidden: (id: string, hidden: boolean) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<ThreadActionResult>;
  onRepairThread: (id: string) => Promise<ThreadActionResult>;
  onResolveConflict: (
    id: string,
    payload: { resolvedText?: string; comment?: string },
  ) => Promise<ThreadActionResult>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onCreateProposal?: ((thread: Thread) => void) | undefined;
  onEditProposal?: ((thread: Thread) => void) | undefined;
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
}

interface ThreadListItem extends ThreadCard {
  id: string;
  blockIndex: number;
  sectionIndexPath: number[];
  startOffset: number;
  createdAt: number;
  latestActivityAt: number;
  isOrphan: boolean;
}

const FOCUS_FLASH_MS = 760;
const FOCUS_HIGHLIGHT_MS = 1800;

/** Names the order the list is in, not the one clicking would pick. */
const SORT_MODE_LABELS: Record<ThreadSortMode, string> = {
  document: 'Document order',
  latest: 'Latest first',
};

export function InlineCommentsList({
  uid,
  threads,
  loading = false,
  onVisibleCountChange,
  sectionFilterCount = 0,
  onClearSectionFilter,
  blockRanges,
  canComment,
  focusedThread,
  displayName,
  mentionCandidates,
  onReply,
  onEdit,
  onSetHidden,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onResolveConflict,
  onReact,
  onCreateProposal,
  onEditProposal,
  onScrollToAnchor,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastHandledFocusNonce = useRef<number | null>(null);

  /** Document-order rank (by source offset) — same approach as the inline column. */
  const blockOrder = useMemo(() => {
    const ranked = Array.from(blockRanges.entries()).sort(([, a], [, b]) => a.start - b.start);
    const order = new Map<string, number>();
    let i = 0;
    for (const [id] of ranked) order.set(id, i++);
    return order;
  }, [blockRanges]);

  const byId = useMemo(() => threadsById(threads), [threads]);

  const { activeItems, orphanedItems, parentOf } = useMemo(() => {
    const activeThreads: Thread[] = [];
    const orphanThreads: Thread[] = [];
    for (const t of threads) {
      const orphan =
        t.link_status === 'orphaned' && (!isProposal(t) || proposalStatus(t) !== 'accepted');
      if (orphan) orphanThreads.push(t);
      else activeThreads.push(t);
    }
    // Nesting is bucket-local: a proposal only merges into its answered
    // thread's card when both would render in the same section, so
    // e.g. an orphaned proposal keeps its standalone card under
    // "Orphaned discussions" instead of vanishing into a linked card.
    const parents = new Map<string, string>();
    const buildItems = (bucket: Thread[], isOrphan: boolean): ThreadListItem[] => {
      const nesting = computeThreadNesting(bucket);
      for (const [id, parentId] of nesting.parentOf) parents.set(id, parentId);
      return nesting.topLevel.map((t) => {
        const nested = nestedThreadsOf(nesting, t.id);
        let latest = latestActivityTs(t);
        for (const n of nested) latest = Math.max(latest, latestActivityTs(n));
        return {
          id: t.id,
          thread: t,
          nested,
          // Drawn from every thread, not just this bucket: a reply of
          // the viewer's counts wherever the conversation carried it.
          linked: linkedThreads(t, nested, byId),
          blockIndex: t.anchor.block_id
            ? (blockOrder.get(t.anchor.block_id) ?? Number.MAX_SAFE_INTEGER)
            : Number.MAX_SAFE_INTEGER,
          sectionIndexPath: t.anchor.section_index_path ?? [],
          startOffset: isProposal(t) ? 0 : (t.anchor.start_offset ?? 0),
          createdAt: t.comments[0].created_at,
          latestActivityAt: latest,
          isOrphan,
        };
      });
    };
    return {
      activeItems: buildItems(activeThreads, false),
      orphanedItems: buildItems(orphanThreads, true),
      parentOf: parents,
    };
  }, [threads, blockOrder, byId]);

  // Whose replies count as answers — the id the server stamps comments
  // with. Read every render, not memoized: pairing adopts the keyring's
  // clientId mid-session, and a frozen one would keep filtering as
  // whoever this browser used to be.
  const viewerClientId = getClientId();

  // Remembered per browser, so the pane opens the way it was left.
  const [sortMode, setSortMode] = useState<ThreadSortMode>(loadThreadSortMode);
  const [filters, setFilters] = useState<ThreadFilters>(loadThreadFilters);
  const [searchQuery, setSearchQuery] = useState('');
  const searchNeedle = useMemo(() => normalizeThreadSearch(searchQuery), [searchQuery]);

  useEffect(() => {
    saveThreadSortMode(sortMode);
  }, [sortMode]);
  useEffect(() => {
    saveThreadFilters(filters);
  }, [filters]);

  const sortedActive = useMemo(() => sortItems(activeItems, sortMode), [activeItems, sortMode]);
  const sortedOrphans = useMemo(
    () => sortItems(orphanedItems, sortMode),
    [orphanedItems, sortMode],
  );

  // A merged card is one unit: search keeps it when the thread or any
  // proposal nested inside it matches, and the filters judge the unit —
  // see cardMatchesFilters.
  const itemMatches = useCallback(
    (item: ThreadListItem) =>
      cardMatchesFilters(item, filters, viewerClientId) &&
      (threadMatchesSearch(item.thread, searchNeedle) ||
        item.nested.some((n) => threadMatchesSearch(n, searchNeedle))),
    [filters, searchNeedle, viewerClientId],
  );
  const visibleActive = useMemo(
    () => sortedActive.filter(itemMatches),
    [sortedActive, itemMatches],
  );
  const visibleOrphans = useMemo(
    () => sortedOrphans.filter(itemMatches),
    [sortedOrphans, itemMatches],
  );
  const visibleCount = visibleActive.length + visibleOrphans.length;

  useEffect(() => {
    onVisibleCountChange(visibleCount);
  }, [visibleCount, onVisibleCountChange]);

  // Collapse state spans every thread, filtered out or not, so toggling a
  // filter never re-expands what the reader collapsed. Nested proposals
  // carry their own entries — their cards collapse independently.
  const collapseDefaults = useMemo(
    () =>
      [...sortedOrphans, ...sortedActive].flatMap((item) => [
        { id: item.id, autoCollapse: shouldAutoCollapse(item.thread) },
        ...item.nested.map((n) => ({ id: n.id, autoCollapse: shouldAutoCollapse(n) })),
      ]),
    [sortedActive, sortedOrphans],
  );
  const [collapseState, setCollapseState] = useState<ThreadCollapseState>(() =>
    buildThreadCollapseState(collapseDefaults),
  );
  const collapsed = collapseState.collapsed;

  useEffect(() => {
    setCollapseState((prev) => reconcileThreadCollapseState(prev, collapseDefaults));
  }, [collapseDefaults]);

  const threadIds = useMemo(() => collapseDefaults.map((d) => d.id), [collapseDefaults]);
  /** Cards in the list — merged units count once, unlike `threadIds`. */
  const totalCards = activeItems.length + orphanedItems.length;
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of [...visibleOrphans, ...visibleActive]) {
      ids.add(item.id);
      for (const n of item.nested) ids.add(n.id);
    }
    return ids;
  }, [visibleActive, visibleOrphans]);
  const allCollapsed = threadIds.length > 0 && threadIds.every((id) => collapsed.has(id));

  /*
   * Only the cards near the viewport are rendered. A card is a heavy tree
   * — a dozen Radix controls each carrying their own context and effects —
   * so re-rendering a thousand of them is what made accepting a proposal
   * freeze the page long after the request had come back.
   */
  const activeKeys = useMemo(() => visibleActive.map((item) => item.id), [visibleActive]);
  const win = useWindowedList({
    keys: activeKeys,
    estimateHeight: DEFAULT_ROW_ESTIMATE,
    rootRef,
    /*
     * Whatever the focus effect below is about to scroll to has to exist
     * in the DOM for it to find, however far down the list it sits.
     *
     * A nested proposal renders inside its parent's card and is not a row
     * of this list, so pinning its own id would find nothing to re-centre
     * on and leave the card that holds it unrendered — the focus effect
     * would then query for an element that was never mounted, and the
     * scroll and flash would silently not happen.
     */
    pinnedKey: focusedThread
      ? (parentOf.get(focusedThread.threadId) ?? focusedThread.threadId)
      : null,
  });
  const windowedActive = useMemo(
    () => visibleActive.slice(win.start, win.end),
    [visibleActive, win.start, win.end],
  );

  /*
   * Record what the rendered cards actually measure, so the spacers above
   * and below them stand for real heights rather than the estimate. Read
   * off the DOM after commit rather than through a ref on each card: the
   * card owns its own root element, and threading a measuring ref through
   * it (and through the nested cards it renders) would put layout
   * plumbing in a component that has no other reason to know about it.
   */
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>(':scope > [data-comment-thread-id]')) {
      const id = el.getAttribute('data-comment-thread-id');
      if (id) win.measure(id)(el);
    }
  });

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);

  // Focus animation: scroll into view, flash, uncollapse if needed.
  useEffect(() => {
    if (!focusedThread) return;
    if (lastHandledFocusNonce.current === focusedThread.nonce) return;
    if (!threadIds.includes(focusedThread.threadId)) return;

    // Opening a thread from elsewhere (activities, history) wins over the
    // filters or search that would otherwise hide it.
    if (!visibleIds.has(focusedThread.threadId)) {
      setFilters(ALL_THREAD_FILTERS);
      setSearchQuery('');
      return;
    }

    // A nested proposal only becomes visible once the card it renders
    // in is expanded too — expand target and parent together.
    const parentId = parentOf.get(focusedThread.threadId);
    const toExpand = [focusedThread.threadId, ...(parentId ? [parentId] : [])].filter((id) =>
      collapsed.has(id),
    );
    if (toExpand.length > 0) {
      setCollapseState((prev) => {
        const expand = toExpand.filter((id) => prev.collapsed.has(id));
        if (expand.length === 0) return prev;
        const next = new Set(prev.collapsed);
        for (const id of expand) next.delete(id);
        return { ...prev, collapsed: next };
      });
      return;
    }

    lastHandledFocusNonce.current = focusedThread.nonce;
    const phase: 'a' | 'b' = focusedThread.nonce % 2 === 0 ? 'b' : 'a';
    setFocusedId(focusedThread.threadId);
    setFlash({ id: focusedThread.threadId, phase });

    const raf = window.requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(
        `[data-comment-thread-id="${CSS.escape(focusedThread.threadId)}"]`,
      );
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const flashT = window.setTimeout(() => {
      setFlash((cur) => (cur?.id === focusedThread.threadId && cur.phase === phase ? null : cur));
    }, FOCUS_FLASH_MS);
    const focusT = window.setTimeout(() => {
      setFocusedId((cur) => (cur === focusedThread.threadId ? null : cur));
    }, FOCUS_HIGHLIGHT_MS);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(flashT);
      window.clearTimeout(focusT);
    };
  }, [focusedThread, threadIds, visibleIds, collapsed, parentOf]);

  const otherSortMode: ThreadSortMode = sortMode === 'document' ? 'latest' : 'document';

  function clearSearch() {
    setSearchQuery('');
    searchInputRef.current?.focus({ preventScroll: true });
  }

  function toggleCollapsed(id: string) {
    setCollapseState((prev) => {
      const next = new Set(prev.collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, collapsed: next };
    });
  }

  function collapseAll() {
    setCollapseState((prev) => {
      const next = new Set(threadIds);
      if (next.size === prev.collapsed.size) {
        let same = true;
        for (const id of next) {
          if (!prev.collapsed.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return { ...prev, collapsed: next };
    });
  }

  const refIndex = useMemo(() => threadRefIndex(threads), [threads]);

  /** Jump to a linked thread by scrolling to its anchor, which focuses it. */
  const focusLinked = useCallback(
    (target: Thread) => {
      const blockId = target.anchor.block_id;
      if (blockId) onScrollToAnchor(blockId, target.anchor.quote, target.id);
    },
    [onScrollToAnchor],
  );

  // Held stable: every comment body's markdown pipeline is keyed on this
  // object, so a fresh one per render re-runs all of them.
  const threadRefs = useMemo<ThreadRefApi>(
    () => ({ resolve: (id) => refIndex.get(id) ?? null, focus: focusLinked }),
    [refIndex, focusLinked],
  );

  function renderCard(
    thread: Thread,
    nested: readonly Thread[],
    parentId: string | null,
  ): ReactNode {
    const blockId = thread.anchor.block_id;
    const onJump = blockId
      ? () => onScrollToAnchor(blockId, thread.anchor.quote, thread.id)
      : undefined;
    const rawLinks = threadLinks(thread, byId);
    // Proposals rendered inside this card need no "See proposed change"
    // link on top — the card itself is right below. A nested proposal
    // likewise drops the "Answers:" link to the card it sits in, but
    // keeps the ones to the other comments it answers.
    const nestedIds = new Set(nested.map((n) => n.id));
    const links = {
      answers: parentId ? rawLinks.answers.filter((t) => t.id !== parentId) : rawLinks.answers,
      answeredBy: rawLinks.answeredBy.filter((t) => !nestedIds.has(t.id)),
    };
    return (
      <InlineThreadCard
        key={thread.id}
        uid={uid}
        thread={thread}
        links={links}
        nested={parentId !== null}
        nestedCards={
          nested.length > 0 ? nested.map((n) => renderCard(n, [], thread.id)) : undefined
        }
        onFocusLinked={focusLinked}
        threadRefs={threadRefs}
        canComment={canComment}
        needsName={!displayName}
        focused={focusedId === thread.id}
        flashPhase={flash?.id === thread.id ? flash.phase : null}
        collapsed={collapsed.has(thread.id)}
        mentionCandidates={mentionCandidates}
        onToggleCollapsed={() => toggleCollapsed(thread.id)}
        onJump={onJump}
        onReply={onReply}
        onEdit={onEdit}
        onSetHidden={onSetHidden}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
        onRepairThread={onRepairThread}
        onResolveConflict={onResolveConflict}
        onReact={onReact}
        onCreateProposal={onCreateProposal}
        onEditProposal={onEditProposal}
      />
    );
  }

  function renderItem(item: ThreadListItem) {
    return renderCard(item.thread, item.nested, null);
  }

  return (
    <div ref={rootRef} className="ic-list">
      {sectionFilterCount > 0 && (
        <div className="ic-list-section-filter-note">
          <FunnelIcon className="ic-list-section-filter-icon" aria-hidden />
          <Text size="1" color="gray" className="ic-list-section-filter-text">
            Threads in{' '}
            {sectionFilterCount === 1
              ? '1 focused section'
              : `${sectionFilterCount} focused sections`}
          </Text>
          {onClearSectionFilter && (
            <Button size="1" variant="ghost" onClick={onClearSectionFilter}>
              Show all
            </Button>
          )}
        </div>
      )}
      {/* Stay mounted while a filter or search is on, or deletions dropping the
          count to one would strand the reader with no way to clear it. A
          document with no threads at all has nothing to filter, and the
          remembered filters would otherwise put a control row above an
          empty pane. */}
      {(totalCards > 1 ||
        (totalCards > 0 && (searchQuery !== '' || isFilteringThreads(filters)))) && (
        <div className="ic-list-controls">
          {/* No disclosure: the box has a row to itself either way, so a
              magnifier that only uncovers it costs a control and a state to
              save nothing. */}
          <TextField.Root
            ref={searchInputRef}
            size="1"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !searchQuery) return;
              e.preventDefault();
              setSearchQuery('');
            }}
            placeholder="Search by id, text, or author"
            aria-label="Search threads by id, text, or author"
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
            {/* Anything in the box gets a way out, including whitespace the
                normalizer throws away — a query that filters nothing still has
                to be clearable. The count is the part that needs a real one. */}
            {searchQuery !== '' && (
              <TextField.Slot side="right" className="ic-list-search-clear-slot">
                {searchNeedle !== '' && (
                  <span className="ic-list-search-count">
                    {visibleCount} of {totalCards}
                  </span>
                )}
                {/* Keeps the caret in the field, so typing can continue. */}
                <button
                  type="button"
                  className="ic-list-search-clear"
                  aria-label="Clear thread search"
                  title="Clear search"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearch}
                >
                  <Cross2Icon className="ic-list-search-clear-icon" />
                </button>
              </TextField.Slot>
            )}
          </TextField.Root>

          <div className="ic-list-controls-bottom">
            {/* Order, not a filter — plain-button dress rather than a pill, so
                it can't read as one of the chips below. The trailing arrows are
                what say it switches; the label alone reads as a caption. */}
            <button
              type="button"
              className="ic-list-sort"
              aria-label={`Sorted by ${SORT_MODE_LABELS[sortMode].toLowerCase()} — switch to ${SORT_MODE_LABELS[otherSortMode].toLowerCase()}`}
              title={`Sort by ${SORT_MODE_LABELS[otherSortMode].toLowerCase()}`}
              onClick={() => setSortMode(otherSortMode)}
            >
              {sortMode === 'document' ? (
                <TextAlignLeftIcon className="ic-list-sort-icon" aria-hidden />
              ) : (
                <ClockIcon className="ic-list-sort-icon" aria-hidden />
              )}
              {SORT_MODE_LABELS[sortMode]}
              <ArrowUpDownIcon className="ic-list-sort-swap" aria-hidden />
            </button>

            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton
                  variant="ghost"
                  size="1"
                  color="gray"
                  className="ic-list-menu-trigger"
                  aria-label="More thread actions"
                >
                  <DotsHorizontalIcon />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={collapseAll} disabled={allCollapsed}>
                  Collapse all threads
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Compact enough to stay put, so there is no disclosure to open and
                no dot to say a filter is on: an unlit chip *is* "all". */}
            {/* biome-ignore lint/a11y/useSemanticElements: <fieldset> is form-only; these are filter switches */}
            <div className="ic-list-filter-chips" role="group" aria-label="Filter threads">
              {THREAD_FILTER_TOGGLES.map((filter) => {
                const on = filter.isOn(filters);
                return (
                  <button
                    key={filter.label}
                    type="button"
                    className="ic-list-filter-chip"
                    aria-pressed={on}
                    title={on ? `Stop showing only ${filter.label.toLowerCase()}` : filter.hint}
                    onClick={() => setFilters(filter.toggle)}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {visibleOrphans.length > 0 && (
        <section className="ic-list-orphans">
          <h4 className="ic-list-section-title">Orphaned discussions</h4>
          <p className="ic-list-section-note">
            These comments or proposed changes could not be matched to the current document.
          </p>
          {visibleOrphans.map(renderItem)}
        </section>
      )}

      {loading && totalCards === 0 && (
        <div className="ic-list-empty" role="status">
          <span className="ic-spinner" aria-hidden="true" /> Loading threads…
        </div>
      )}

      {!loading && totalCards === 0 && (
        <div className="ic-list-empty">
          {sectionFilterCount > 0
            ? 'No threads in the focused sections.'
            : canComment
              ? 'Select text in the document to comment.'
              : 'You have read-only access to this document.'}
        </div>
      )}

      {totalCards > 0 && visibleCount === 0 && (
        <div className="ic-list-empty">
          {searchNeedle !== ''
            ? 'No threads match this search.'
            : 'No threads match the selected filters.'}
        </div>
      )}

      {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
      {windowedActive.map(renderItem)}
      {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
    </div>
  );
}

function shouldAutoCollapse(t: Thread): boolean {
  if (t.state === 'resolved') return true;
  if (isProposal(t)) {
    const s = proposalStatus(t);
    if (s === 'accepted' || s === 'rejected') return true;
  }
  return false;
}

/**
 * The threads a card cross-links to: proposals answering it that render
 * in another card, and the comments a proposal card answers. What the
 * card already renders inside itself is not a link.
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

function latestActivityTs(t: Thread): number {
  let latest = t.comments[0].updated_at;
  for (const c of t.comments) {
    if (c.updated_at > latest) latest = c.updated_at;
  }
  return latest;
}

function sortItems(items: ThreadListItem[], mode: ThreadSortMode): ThreadListItem[] {
  return [...items].sort((a, b) =>
    mode === 'latest' ? compareLatest(a, b) : compareDocument(a, b),
  );
}

function compareLatest(a: ThreadListItem, b: ThreadListItem): number {
  return b.latestActivityAt - a.latestActivityAt || a.createdAt - b.createdAt;
}

function compareDocument(a: ThreadListItem, b: ThreadListItem): number {
  if (a.blockIndex !== b.blockIndex) return a.blockIndex - b.blockIndex;
  // Same block: tiebreak by section path (matches reanchor's notion of
  // "n-th block under heading X") then by start offset, then created.
  const len = Math.max(a.sectionIndexPath.length, b.sectionIndexPath.length);
  for (let i = 0; i < len; i++) {
    const av = a.sectionIndexPath[i] ?? Number.MAX_SAFE_INTEGER;
    const bv = b.sectionIndexPath[i] ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
  }
  if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
  return a.createdAt - b.createdAt;
}
