import type { BlockSourceRange } from '@marginalia/renderer';
import { DotsHorizontalIcon } from '@radix-ui/react-icons';
import {
  Badge,
  Button,
  DropdownMenu,
  Flex,
  IconButton,
  SegmentedControl,
  Text,
} from '@radix-ui/themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommentAnchor, Thread } from '../lib/api.js';
import { isProposal, proposalStatus } from '../lib/api.js';
import {
  CommentComposer,
  type ComposerHandle,
} from './ThreadComposer.js';
import { ThreadItem } from './ThreadItem.js';
import { buildThreadCollapseState, reconcileThreadCollapseState } from './threadCollapseState.js';

interface Props {
  uid: string;
  threads: Thread[];
  /** Live document source, used by diff/composer. */
  docSource: string;
  /**
   * Per-block source ranges, memoized in DocumentLayout and passed in so
   * this pane and the proposal composer share one parse of the source
   * instead of each re-parsing on every render.
   */
  blockRanges: Map<string, BlockSourceRange>;
  mentionCandidates: string[];
  canComment: boolean;
  /** New-comment draft captured from selection; non-null → composer is open */
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number } | null;
  onCancelPending: () => void;
  /** Null if the viewer hasn't set a display name yet — Composer will ask. */
  displayName: string | null;
  onCreate: (payload: { anchor: CommentAnchor; body: string; display_name?: string }) => Promise<void>;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (nodeId: string, body: string) => Promise<void>;
  onDeleteNode: (nodeId: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<void>;
  onEditProposalRationale: (id: string, rationale: string | null) => Promise<void>;
  /** Scroll the document pane to a block and flash it. */
  onScrollToAnchor: (blockId: string) => void;
}

interface ThreadAnchorOrder {
  blockId: string | null;
  sectionIndex: number | null;
  sectionIndexPath: number[];
  startOffset: number | null;
}

type ThreadListItem = {
  kind: 'comment' | 'proposal';
  id: string;
  createdAt: number;
  latestActivityAt: number;
  anchor: ThreadAnchorOrder;
  thread: Thread;
};

type CommentSortMode = 'document' | 'latest';
type ThreadFlashState = {
  threadId: string;
  phase: 'a' | 'b';
};
const THREAD_FOCUS_FLASH_MS = 760;
const THREAD_FOCUS_HIGHLIGHT_MS = 1800;

export function CommentsPane(props: Props) {
  const {
    uid,
    threads,
    docSource,
    blockRanges,
    mentionCandidates,
    canComment,
    pendingAnchor,
    focusedThread,
    onCancelPending,
    displayName,
    onCreate,
    onReply,
    onEdit,
    onDeleteNode,
    onDeleteThread,
    onResolveThread,
    onEditProposalRationale,
    onScrollToAnchor,
  } = props;

  const blockOrder = useMemo(() => {
    const order = new Map<string, number>();
    let index = 0;
    for (const blockId of blockRanges.keys()) {
      order.set(blockId, index);
      index += 1;
    }
    return order;
  }, [blockRanges]);

  const { activeThreads, orphanedThreads } = useMemo(() => {
    const active: ThreadListItem[] = [];
    const orphans: ThreadListItem[] = [];
    for (const t of threads) {
      const kind = isProposal(t) ? 'proposal' : 'comment';
      const orphan =
        t.link_status === 'orphaned' &&
        (!isProposal(t) || proposalStatus(t) !== 'accepted');
      const item: ThreadListItem = {
        kind,
        id: t.id,
        createdAt: t.root.created_at,
        latestActivityAt: threadLatestActivityTs(t),
        anchor: anchorOrderFromThread(t),
        thread: t,
      };
      if (orphan) orphans.push(item);
      else active.push(item);
    }
    return { activeThreads: active, orphanedThreads: orphans };
  }, [threads]);

  const [sortMode, setSortMode] = useState<CommentSortMode>('document');

  const sortedActive = useMemo(
    () => sortThreadItems(activeThreads, sortMode, blockOrder),
    [activeThreads, blockOrder, sortMode],
  );
  const sortedOrphans = useMemo(
    () => sortThreadItems(orphanedThreads, sortMode, blockOrder),
    [blockOrder, orphanedThreads, sortMode],
  );

  const threadCollapseDefaults = useMemo(
    () =>
      [...sortedOrphans, ...sortedActive].map((item) => ({
        id: item.id,
        autoCollapse: item.thread.state === 'resolved',
      })),
    [sortedActive, sortedOrphans],
  );
  const [threadCollapseState, setThreadCollapseState] = useState(() =>
    buildThreadCollapseState(threadCollapseDefaults),
  );
  const collapsedThreads = threadCollapseState.collapsed;
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [flashingThread, setFlashingThread] = useState<ThreadFlashState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHandledFocusNonce = useRef<number | null>(null);
  const threadIds = useMemo(
    () => threadCollapseDefaults.map((t) => t.id),
    [threadCollapseDefaults],
  );
  const focusedThreadExists = focusedThread ? threadIds.includes(focusedThread.threadId) : false;
  const totalThreads = threadIds.length;
  const allCollapsed =
    totalThreads > 0 && threadIds.every((threadId) => collapsedThreads.has(threadId));

  useEffect(() => {
    setThreadCollapseState((prev) => reconcileThreadCollapseState(prev, threadCollapseDefaults));
  }, [threadCollapseDefaults]);

  useEffect(() => {
    if (!focusedThread) return;
    if (!focusedThreadExists) return;
    if (lastHandledFocusNonce.current === focusedThread.nonce) return;

    if (collapsedThreads.has(focusedThread.threadId)) {
      setThreadCollapseState((prev) => {
        if (!prev.collapsed.has(focusedThread.threadId)) return prev;
        const next = new Set(prev.collapsed);
        next.delete(focusedThread.threadId);
        return { ...prev, collapsed: next };
      });
      return;
    }

    const selector = `[data-comment-thread-id="${CSS.escape(focusedThread.threadId)}"]`;
    const threadEl = rootRef.current?.querySelector<HTMLElement>(selector);
    if (!threadEl) return;

    lastHandledFocusNonce.current = focusedThread.nonce;
    setFocusedThreadId(focusedThread.threadId);
    const flashPhase = focusedThread.nonce % 2 === 0 ? 'b' : 'a';
    setFlashingThread({ threadId: focusedThread.threadId, phase: flashPhase });
    const frame = window.requestAnimationFrame(() => {
      threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const flashTimeout = window.setTimeout(() => {
      setFlashingThread((current) =>
        current?.threadId === focusedThread.threadId && current.phase === flashPhase
          ? null
          : current,
      );
    }, THREAD_FOCUS_FLASH_MS);
    const timeout = window.setTimeout(() => {
      setFocusedThreadId((current) => (current === focusedThread.threadId ? null : current));
    }, THREAD_FOCUS_HIGHLIGHT_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(flashTimeout);
      window.clearTimeout(timeout);
    };
  }, [collapsedThreads, focusedThread, focusedThreadExists]);

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  function toggleCollapsed(threadId: string) {
    setThreadCollapseState((prev) => {
      const next = new Set(prev.collapsed);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return { ...prev, collapsed: next };
    });
  }

  function renderThread(item: ThreadListItem) {
    const { thread } = item;
    return (
      <ThreadItem
        key={thread.id}
        uid={uid}
        thread={thread}
        canComment={canComment}
        mentionCandidates={mentionCandidates}
        docSource={docSource}
        blockRanges={blockRanges}
        needsName={!displayName}
        threadFocused={focusedThreadId === thread.id}
        threadFlashPhase={
          flashingThread?.threadId === thread.id ? flashingThread.phase : null
        }
        collapsed={collapsedThreads.has(thread.id)}
        onToggleCollapsed={() => toggleCollapsed(thread.id)}
        onReply={onReply}
        onEditBody={onEdit}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
        onEditRationale={onEditProposalRationale}
        onScrollToAnchor={onScrollToAnchor}
      />
    );
  }

  return (
    <div ref={rootRef} className="comments-pane">
      {totalThreads > 1 && (
        <Flex align="center" gap="2" className="comments-pane-toolbar">
          <Text as="label" htmlFor="threads-sort" size="1" color="gray">
            Sort by
          </Text>
          <SegmentedControl.Root
            id="threads-sort"
            size="1"
            value={sortMode}
            onValueChange={(value) => setSortMode(value as CommentSortMode)}
            aria-label="Sort threads"
          >
            <SegmentedControl.Item value="document" title="Appearance in document">
              Appearance
            </SegmentedControl.Item>
            <SegmentedControl.Item value="latest" title="Latest activity first">
              Latest
            </SegmentedControl.Item>
          </SegmentedControl.Root>
          <span className="spacer" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton variant="ghost" size="1" aria-label="More thread actions">
                <DotsHorizontalIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                onSelect={() =>
                  setThreadCollapseState((prev) => {
                    const next = new Set(threadIds);
                    if (next.size === prev.collapsed.size) {
                      let identical = true;
                      for (const threadId of next) {
                        if (!prev.collapsed.has(threadId)) {
                          identical = false;
                          break;
                        }
                      }
                      if (identical) return prev;
                    }
                    return { ...prev, collapsed: next };
                  })
                }
                disabled={allCollapsed}
              >
                Collapse all threads
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>
      )}

      {canComment && pendingAnchor && (
        <div className="comment-composer">
          <div className="composer-quote">"{pendingAnchor.quote}"</div>
          <CommentComposer
            mentionCandidates={mentionCandidates}
            placeholder="Your comment…"
            needsName={!displayName}
            onCancel={onCancelPending}
            onSubmit={submitNew}
          />
        </div>
      )}

      {sortedOrphans.length > 0 && (
        <section className="orphans">
          <h4 className="subtle">Orphaned discussions</h4>
          <p className="subtle small">
            These comments or proposed changes could not be matched to the current document.
          </p>
          {sortedOrphans.map((item) => renderThread(item))}
        </section>
      )}

      {totalThreads === 0 && !pendingAnchor && (
        <div className="comments-empty subtle">
          {canComment
            ? 'Select text in the document to comment.'
            : 'You have read-only access to this document.'}
        </div>
      )}

      {sortedActive.map((item) => renderThread(item))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortThreadItems(
  items: ThreadListItem[],
  sortMode: CommentSortMode,
  blockOrder: Map<string, number>,
): ThreadListItem[] {
  return [...items].sort((a, b) =>
    sortMode === 'latest'
      ? compareByLatestDesc(a, b)
      : compareByDocumentOrder(a, b, blockOrder),
  );
}

function compareByLatestDesc(a: ThreadListItem, b: ThreadListItem): number {
  return b.latestActivityAt - a.latestActivityAt || a.createdAt - b.createdAt;
}

function compareByDocumentOrder(
  a: ThreadListItem,
  b: ThreadListItem,
  blockOrder: Map<string, number>,
): number {
  const anchorCmp = compareThreadAnchorOrder(a.anchor, b.anchor, blockOrder);
  if (anchorCmp !== 0) return anchorCmp;
  return a.createdAt - b.createdAt;
}

function compareThreadAnchorOrder(
  a: ThreadAnchorOrder,
  b: ThreadAnchorOrder,
  blockOrder: Map<string, number>,
): number {
  const aBlockIndex = a.blockId ? (blockOrder.get(a.blockId) ?? null) : null;
  const bBlockIndex = b.blockId ? (blockOrder.get(b.blockId) ?? null) : null;
  const blockCmp = compareNullableNumber(aBlockIndex, bBlockIndex);
  if (blockCmp !== 0) return blockCmp;

  const pathCmp = compareNumberArrays(normalizeThreadAnchorPath(a), normalizeThreadAnchorPath(b));
  if (pathCmp !== 0) return pathCmp;

  if (a.startOffset !== null && b.startOffset !== null && a.startOffset !== b.startOffset) {
    return a.startOffset - b.startOffset;
  }

  return 0;
}

function compareNumberArrays(aPath: number[], bPath: number[]): number {
  const len = Math.max(aPath.length, bPath.length);
  for (let i = 0; i < len; i += 1) {
    const aPart = aPath[i] ?? Number.MAX_SAFE_INTEGER;
    const bPart = bPath[i] ?? Number.MAX_SAFE_INTEGER;
    if (aPart !== bPart) return aPart - bPart;
  }
  return 0;
}

function normalizeThreadAnchorPath(anchor: ThreadAnchorOrder): number[] {
  if (anchor.sectionIndexPath.length > 0) return anchor.sectionIndexPath;
  if (anchor.sectionIndex !== null) return [anchor.sectionIndex];
  return [];
}

function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function threadLatestActivityTs(thread: Thread): number {
  let latest = thread.root.updated_at;
  for (const reply of thread.replies) {
    if (reply.updated_at > latest) latest = reply.updated_at;
  }
  return latest;
}

function anchorOrderFromThread(thread: Thread): ThreadAnchorOrder {
  return {
    blockId: thread.anchor.block_id,
    sectionIndex: thread.anchor.section_index,
    sectionIndexPath: thread.anchor.section_index_path ?? [],
    startOffset: isProposal(thread) ? null : thread.anchor.start_offset,
  };
}
