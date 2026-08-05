import type { BlockSourceRange } from '@marginalia/renderer';
import { DotsHorizontalIcon, MixerHorizontalIcon } from '@radix-ui/react-icons';
import { DropdownMenu, IconButton, SegmentedControl, Text } from '@radix-ui/themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { CommentAnchor, Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';
import {
  buildThreadCollapseState,
  reconcileThreadCollapseState,
  type ThreadCollapseState,
} from '../threadCollapseState.js';
import { InlineComposer } from './InlineComposer.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import { threadLinks, threadsById } from './inlineUtils.js';
import {
  ALL_THREAD_FILTERS,
  activeThreadFilterLabels,
  isFilteringThreads,
  type ThreadFilters,
  type ThreadKindFilter,
  type ThreadStatusFilter,
  threadMatchesFilters,
} from './threadFilters.js';

/**
 * Right-pane list of comment threads using the same inline-comment
 * cards as the document column, but laid out as a flat vertical list
 * (no sticky/anchored positioning, no scroll coupling). Sortable
 * between document order and latest activity.
 *
 * Replaces the legacy CommentsPane / ThreadItem / CommentItem /
 * DiscussionUi stack — the cards from inline-comments/ are now the
 * single source of truth for thread rendering.
 */
interface Props {
  uid: string;
  threads: Thread[];
  blockRanges: Map<string, BlockSourceRange>;
  canComment: boolean;
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number } | null;
  displayName: string | null;
  mentionCandidates: string[];
  onCancelPending: () => void;
  onCreate: (payload: {
    anchor: CommentAnchor;
    body: string;
    display_name?: string;
  }) => Promise<void>;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<boolean>;
  onRepairThread: (id: string) => Promise<boolean>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
}

type SortMode = 'document' | 'latest';

interface ThreadListItem {
  id: string;
  thread: Thread;
  blockIndex: number;
  sectionIndexPath: number[];
  startOffset: number;
  createdAt: number;
  latestActivityAt: number;
  isOrphan: boolean;
}

const FOCUS_FLASH_MS = 760;
const FOCUS_HIGHLIGHT_MS = 1800;

export function InlineCommentsList({
  uid,
  threads,
  blockRanges,
  canComment,
  pendingAnchor,
  focusedThread,
  displayName,
  mentionCandidates,
  onCancelPending,
  onCreate,
  onReply,
  onEdit,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onReact,
  onScrollToAnchor,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHandledFocusNonce = useRef<number | null>(null);

  /** Document-order rank (by source offset) — same approach as the inline column. */
  const blockOrder = useMemo(() => {
    const ranked = Array.from(blockRanges.entries()).sort(([, a], [, b]) => a.start - b.start);
    const order = new Map<string, number>();
    let i = 0;
    for (const [id] of ranked) order.set(id, i++);
    return order;
  }, [blockRanges]);

  const { activeItems, orphanedItems } = useMemo(() => {
    const active: ThreadListItem[] = [];
    const orphans: ThreadListItem[] = [];
    for (const t of threads) {
      const orphan =
        t.link_status === 'orphaned' && (!isProposal(t) || proposalStatus(t) !== 'accepted');
      const item: ThreadListItem = {
        id: t.id,
        thread: t,
        blockIndex: t.anchor.block_id
          ? (blockOrder.get(t.anchor.block_id) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER,
        sectionIndexPath: t.anchor.section_index_path ?? [],
        startOffset: isProposal(t) ? 0 : (t.anchor.start_offset ?? 0),
        createdAt: t.comments[0].created_at,
        latestActivityAt: latestActivityTs(t),
        isOrphan: orphan,
      };
      if (orphan) orphans.push(item);
      else active.push(item);
    }
    return { activeItems: active, orphanedItems: orphans };
  }, [threads, blockOrder]);

  const [sortMode, setSortMode] = useState<SortMode>('document');
  const [filters, setFilters] = useState<ThreadFilters>(ALL_THREAD_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const sortedActive = useMemo(() => sortItems(activeItems, sortMode), [activeItems, sortMode]);
  const sortedOrphans = useMemo(
    () => sortItems(orphanedItems, sortMode),
    [orphanedItems, sortMode],
  );

  const visibleActive = useMemo(
    () => sortedActive.filter((item) => threadMatchesFilters(item.thread, filters)),
    [sortedActive, filters],
  );
  const visibleOrphans = useMemo(
    () => sortedOrphans.filter((item) => threadMatchesFilters(item.thread, filters)),
    [sortedOrphans, filters],
  );
  const visibleCount = visibleActive.length + visibleOrphans.length;

  // Collapse state spans every thread, filtered out or not, so toggling a
  // filter never re-expands what the reader collapsed.
  const collapseDefaults = useMemo(
    () =>
      [...sortedOrphans, ...sortedActive].map((item) => ({
        id: item.id,
        autoCollapse: shouldAutoCollapse(item.thread),
      })),
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
  const totalThreads = threadIds.length;
  const visibleIds = useMemo(
    () => new Set([...visibleOrphans, ...visibleActive].map((item) => item.id)),
    [visibleActive, visibleOrphans],
  );
  const allCollapsed = totalThreads > 0 && threadIds.every((id) => collapsed.has(id));

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);

  // Focus animation: scroll into view, flash, uncollapse if needed.
  useEffect(() => {
    if (!focusedThread) return;
    if (lastHandledFocusNonce.current === focusedThread.nonce) return;
    if (!threadIds.includes(focusedThread.threadId)) return;

    // Opening a thread from elsewhere (activities, history) wins over the
    // filters that would otherwise hide it.
    if (!visibleIds.has(focusedThread.threadId)) {
      setFilters(ALL_THREAD_FILTERS);
      return;
    }

    if (collapsed.has(focusedThread.threadId)) {
      setCollapseState((prev) => {
        if (!prev.collapsed.has(focusedThread.threadId)) return prev;
        const next = new Set(prev.collapsed);
        next.delete(focusedThread.threadId);
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
  }, [focusedThread, threadIds, visibleIds, collapsed]);

  const activeFilters = activeThreadFilterLabels(filters);
  const filterToggleLabel = filtersOpen
    ? 'Hide thread filters'
    : activeFilters.length > 0
      ? `Thread filters — ${activeFilters.join(', ')}`
      : 'Filter threads';

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

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  const byId = useMemo(() => threadsById(threads), [threads]);

  /** Jump to a linked thread by scrolling to its anchor, which focuses it. */
  function focusLinked(target: Thread) {
    const blockId = target.anchor.block_id;
    if (blockId) onScrollToAnchor(blockId, target.anchor.quote, target.id);
  }

  function renderItem(item: ThreadListItem) {
    const blockId = item.thread.anchor.block_id;
    const onJump = blockId
      ? () => onScrollToAnchor(blockId, item.thread.anchor.quote, item.thread.id)
      : undefined;
    return (
      <InlineThreadCard
        key={item.id}
        uid={uid}
        thread={item.thread}
        links={threadLinks(item.thread, byId)}
        onFocusLinked={focusLinked}
        canComment={canComment}
        needsName={!displayName}
        focused={focusedId === item.id}
        flashPhase={flash?.id === item.id ? flash.phase : null}
        collapsed={collapsed.has(item.id)}
        mentionCandidates={mentionCandidates}
        onToggleCollapsed={() => toggleCollapsed(item.id)}
        onJump={onJump}
        onReply={onReply}
        onEdit={onEdit}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
        onRepairThread={onRepairThread}
        onReact={onReact}
      />
    );
  }

  return (
    <div ref={rootRef} className="ic-list">
      {/* Stay mounted while a filter is on, or deletions dropping the count to
          one would strand the reader with no way to clear it. */}
      {(totalThreads > 1 || isFilteringThreads(filters)) && (
        <div className="ic-list-controls">
          {/* Wraps: one row on a wide pane, one row per control on a narrow one. */}
          <div className="ic-list-control-groups">
            <div className="ic-list-control">
              <Text as="label" htmlFor="ic-list-sort" size="1" color="gray">
                Sort by
              </Text>
              <SegmentedControl.Root
                id="ic-list-sort"
                size="1"
                value={sortMode}
                onValueChange={(v) => setSortMode(v as SortMode)}
                aria-label="Sort threads"
              >
                <SegmentedControl.Item value="document" title="Appearance in document">
                  Appearance
                </SegmentedControl.Item>
                <SegmentedControl.Item value="latest" title="Latest activity first">
                  Latest
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            </div>

            {filtersOpen && (
              <>
                <div className="ic-list-control">
                  <Text as="label" htmlFor="ic-list-filter-status" size="1" color="gray">
                    Status
                  </Text>
                  <SegmentedControl.Root
                    id="ic-list-filter-status"
                    size="1"
                    value={filters.status}
                    onValueChange={(v) =>
                      setFilters((prev) => ({ ...prev, status: v as ThreadStatusFilter }))
                    }
                    aria-label="Filter threads by status"
                  >
                    <SegmentedControl.Item value="all" title="Resolved and unresolved threads">
                      All
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="unresolved" title="Only threads still open">
                      Unresolved
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>
                <div className="ic-list-control">
                  <Text as="label" htmlFor="ic-list-filter-kind" size="1" color="gray">
                    Type
                  </Text>
                  <SegmentedControl.Root
                    id="ic-list-filter-kind"
                    size="1"
                    value={filters.kind}
                    onValueChange={(v) =>
                      setFilters((prev) => ({ ...prev, kind: v as ThreadKindFilter }))
                    }
                    aria-label="Filter threads by type"
                  >
                    <SegmentedControl.Item value="all" title="Comments and edit proposals">
                      All
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="proposals" title="Only edit proposals">
                      Proposals
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>
              </>
            )}
          </div>

          <div className="ic-list-controls-actions">
            {/* Accent (rather than gray) while filtering, so the state carries
                even where the indicator dot is easy to miss. */}
            {/* Stays `ghost` in both states — `soft` drops the negative margin
                a ghost button carries, so the icon visibly grows on toggle. */}
            <IconButton
              variant="ghost"
              size="1"
              {...(activeFilters.length > 0 ? {} : { color: 'gray' as const })}
              className="ic-list-filter-toggle"
              data-filtering={activeFilters.length > 0 ? 'true' : undefined}
              aria-expanded={filtersOpen}
              aria-label={filterToggleLabel}
              title={filterToggleLabel}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <MixerHorizontalIcon />
            </IconButton>
            {/* The menu has nothing to do with filtering — don't let the two
                icons read as one control. */}
            <span className="ic-list-controls-divider" aria-hidden="true" />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton variant="ghost" size="1" aria-label="More thread actions">
                  <DotsHorizontalIcon />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item onSelect={collapseAll} disabled={allCollapsed}>
                  Collapse all threads
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        </div>
      )}

      {canComment && pendingAnchor && (
        <div className="ic-card ic-card-pending">
          <div className="ic-pending-quote">"{formatAnchorQuote(pendingAnchor.quote, 160)}"</div>
          <InlineComposer
            placeholder="Your comment…"
            needsName={!displayName}
            mentionCandidates={mentionCandidates}
            rows={3}
            submitLabel="Post"
            showCancel
            autoFocus
            onCancel={onCancelPending}
            onSubmit={submitNew}
          />
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

      {totalThreads === 0 && !pendingAnchor && (
        <div className="ic-list-empty">
          {canComment
            ? 'Select text in the document to comment.'
            : 'You have read-only access to this document.'}
        </div>
      )}

      {totalThreads > 0 && visibleCount === 0 && (
        <div className="ic-list-empty">No threads match the selected filters.</div>
      )}

      {visibleActive.map(renderItem)}
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

function latestActivityTs(t: Thread): number {
  let latest = t.comments[0].updated_at;
  for (const c of t.comments) {
    if (c.updated_at > latest) latest = c.updated_at;
  }
  return latest;
}

function sortItems(items: ThreadListItem[], mode: SortMode): ThreadListItem[] {
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
