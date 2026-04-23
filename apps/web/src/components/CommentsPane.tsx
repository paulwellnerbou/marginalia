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
import type { Comment, CommentAnchor, EditProposal } from '../lib/api.js';
import {
  CommentComposer,
  type ComposerFooterContext,
  type ComposerHandle,
} from './CommentComposer.js';
import { CommentItem } from './CommentItem.js';
import { DiscussionThread } from './DiscussionUi.js';
import { EditProposalItem } from './EditProposalItem.js';
import { buildThreadCollapseState, reconcileThreadCollapseState } from './threadCollapseState.js';

interface Props {
  uid: string;
  comments: Comment[];
  proposals: EditProposal[];
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
  /** Viewer has edit rights (admin or editor). */
  canEdit: boolean;
  isDocAdmin: boolean;
  viewerClientId: string;
  /** Null if the viewer hasn't set a display name yet — Composer will ask. */
  displayName: string | null;
  onCreate: (payload: {
    anchor?: CommentAnchor;
    parent_id?: string;
    parent_proposal_id?: string;
    body: string;
    display_name?: string;
  }) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean, body?: string, name?: string) => Promise<void>;
  onAcceptProposal: (id: string, body?: string, name?: string) => Promise<void>;
  onRejectProposal: (id: string, body?: string, name?: string) => Promise<void>;
  onDeleteProposal: (id: string) => Promise<void>;
  onEditProposalRationale: (id: string, rationale: string | null) => Promise<void>;
  /** Scroll the document pane to a block and flash it. */
  onScrollToAnchor: (blockId: string) => void;
}

interface AnchorGroup {
  top: Comment;
  replies: Comment[];
}

interface ProposalThread {
  proposal: EditProposal;
  replies: Comment[];
}

interface ThreadAnchorOrder {
  blockId: string | null;
  sectionIndex: number | null;
  sectionIndexPath: number[];
  startOffset: number | null;
}

type ThreadListItem =
  | {
      kind: 'comment';
      id: string;
      createdAt: number;
      latestActivityAt: number;
      anchor: ThreadAnchorOrder;
      group: AnchorGroup;
    }
  | {
      kind: 'proposal';
      id: string;
      createdAt: number;
      latestActivityAt: number;
      anchor: ThreadAnchorOrder;
      thread: ProposalThread;
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
    comments,
    proposals,
    docSource,
    blockRanges,
    mentionCandidates,
    canComment,
    pendingAnchor,
    focusedThread,
    onCancelPending,
    canEdit,
    isDocAdmin,
    viewerClientId,
    displayName,
    onCreate,
    onEdit,
    onDelete,
    onResolve,
    onAcceptProposal,
    onRejectProposal,
    onDeleteProposal,
    onEditProposalRationale,
    onScrollToAnchor,
  } = props;
  // Replies pinned to a specific proposal are rendered under that
  // proposal, not as part of the normal anchored-comment threads.
  const proposalReplies = useMemo(() => {
    const by = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!c.parent_proposal_id) continue;
      const list = by.get(c.parent_proposal_id);
      if (list) list.push(c);
      else by.set(c.parent_proposal_id, [c]);
    }
    for (const list of by.values()) list.sort((a, b) => a.created_at - b.created_at);
    return by;
  }, [comments]);
  const commentsWithoutProposalReplies = useMemo(
    () => comments.filter((c) => !c.parent_proposal_id),
    [comments],
  );
  const blockOrder = useMemo(() => {
    const order = new Map<string, number>();
    let index = 0;
    for (const blockId of blockRanges.keys()) {
      order.set(blockId, index);
      index += 1;
    }
    return order;
  }, [blockRanges]);
  const { active: activeProposalThreads, orphans: orphanedProposalThreads } = useMemo(
    () => groupProposalThreads(proposals, proposalReplies),
    [proposalReplies, proposals],
  );
  const [sortMode, setSortMode] = useState<CommentSortMode>('document');
  const { active, orphans } = useMemo(
    () => groupByAnchor(commentsWithoutProposalReplies, sortMode),
    [commentsWithoutProposalReplies, sortMode],
  );
  const activeThreads = useMemo(
    () => combineThreads(active, activeProposalThreads, sortMode, blockOrder),
    [active, activeProposalThreads, blockOrder, sortMode],
  );
  const orphanedThreads = useMemo(
    () => combineThreads(orphans, orphanedProposalThreads, sortMode, blockOrder),
    [blockOrder, orphanedProposalThreads, orphans, sortMode],
  );
  const threadCollapseDefaults = useMemo(
    () =>
      [...orphanedThreads, ...activeThreads].map((thread) => ({
        id: thread.id,
        autoCollapse: shouldThreadAutoCollapse(thread),
      })),
    [activeThreads, orphanedThreads],
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
    () => threadCollapseDefaults.map((thread) => thread.id),
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
        current?.threadId === focusedThread.threadId && current.phase === flashPhase ? null : current,
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
    await onCreate(payload);
  }

  async function submitReply(parentId: string, body: string, name?: string) {
    const payload: Parameters<typeof onCreate>[0] = { parent_id: parentId, body };
    if (name !== undefined) payload.display_name = name;
    await onCreate(payload);
  }

  async function submitProposalReply(proposalId: string, body: string, name?: string) {
    const payload: Parameters<typeof onCreate>[0] = { parent_proposal_id: proposalId, body };
    if (name !== undefined) payload.display_name = name;
    await onCreate(payload);
  }

  function toggleCollapsed(threadId: string) {
    setThreadCollapseState((prev) => {
      const next = new Set(prev.collapsed);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return { ...prev, collapsed: next };
    });
  }

  function renderThread(thread: ThreadListItem) {
    const sharedThreadState = {
      canComment,
      needsName: !displayName,
      threadFocused: focusedThreadId === thread.id,
      threadFlashPhase: flashingThread?.threadId === thread.id ? flashingThread.phase : null,
      collapsed: collapsedThreads.has(thread.id),
      onToggleCollapsed: () => toggleCollapsed(thread.id),
    };

    if (thread.kind === 'comment') {
      return (
        <AnchorGroupView
          key={thread.id}
          group={thread.group}
          isDocAdmin={isDocAdmin}
          viewerClientId={viewerClientId}
          submitReply={submitReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onResolve={onResolve}
          onScrollToAnchor={onScrollToAnchor}
          mentionCandidates={mentionCandidates}
          {...sharedThreadState}
        />
      );
    }

    return (
      <EditProposalItem
        key={thread.id}
        uid={uid}
        proposal={thread.thread.proposal}
        replies={thread.thread.replies}
        docSource={docSource}
        blockRanges={blockRanges}
        canEdit={canEdit}
        mentionCandidates={mentionCandidates}
        isDocAdmin={isDocAdmin}
        onAccept={onAcceptProposal}
        onReject={onRejectProposal}
        onDelete={onDeleteProposal}
        onEditRationale={onEditProposalRationale}
        onReply={submitProposalReply}
        onEditReply={onEdit}
        onDeleteReply={onDelete}
        onScrollToAnchor={onScrollToAnchor}
        {...sharedThreadState}
      />
    );
  }

  return (
    <div ref={rootRef} className="comments-pane">
      {totalThreads > 1 && (
        <Flex align="center" gap="2" className="comments-pane-toolbar">
          {/* Keep thread sorting visible even when proposal/composer sections
              add content above the first thread list. */}
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
          {/* Collapse-all is the one low-frequency bulk action — tucked into
              an overflow menu so it's reachable without cluttering the bar.
              No "Expand all" — if the user wants to read a thread they just
              click that thread's chevron; collapsing is the only useful
              bulk direction. */}
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
          <div className="composer-quote">“{pendingAnchor.quote}”</div>
          <CommentComposer
            mentionCandidates={mentionCandidates}
            placeholder="Your comment…"
            needsName={!displayName}
            onCancel={onCancelPending}
            onSubmit={submitNew}
          />
        </div>
      )}

      {orphanedThreads.length > 0 && (
        <section className="orphans">
          <h4 className="subtle">Orphaned discussions</h4>
          <p className="subtle small">
            These comments or proposed changes could not be matched to the current document.
          </p>
          {orphanedThreads.map((thread) => renderThread(thread))}
        </section>
      )}

      {activeThreads.length === 0 && !pendingAnchor && orphanedThreads.length === 0 && (
        <div className="comments-empty subtle">
          {canComment
            ? 'Select text in the document to comment.'
            : 'You have read-only access to this document.'}
        </div>
      )}

      {activeThreads.map((thread) => renderThread(thread))}
    </div>
  );
}

function AnchorGroupView({
  group,
  isDocAdmin,
  viewerClientId,
  mentionCandidates,
  canComment,
  submitReply,
  onEdit,
  onDelete,
  onResolve,
  onScrollToAnchor,
  needsName,
  threadFocused,
  threadFlashPhase,
  collapsed,
  onToggleCollapsed,
}: {
  group: AnchorGroup;
  isDocAdmin: boolean;
  viewerClientId: string;
  mentionCandidates: string[];
  canComment: boolean;
  submitReply: (parentId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean, body?: string, name?: string) => Promise<void>;
  onScrollToAnchor: (blockId: string) => void;
  needsName: boolean;
  threadFocused: boolean;
  threadFlashPhase?: 'a' | 'b' | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const isResolved = group.top.resolved_at !== null;
  const canResolve = isDocAdmin || group.top.author.client_id === viewerClientId;
  const anchorBlockId = group.top.anchor?.block_id ?? null;

  const composerRef = useRef<ComposerHandle>(null);

  const handleQuote = (text: string) => {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    composerRef.current?.insertText(quoted);
  };

  // Clicking the quote or the thread-jump button scrolls the document pane
  // to the commented block.
  const jump = anchorBlockId ? () => onScrollToAnchor(anchorBlockId) : undefined;
  const toolbarActions = isResolved ? (
    <Badge color="green" variant="soft">
      Resolved{group.top.resolved_by_name ? ` by ${group.top.resolved_by_name}` : ''}
    </Badge>
  ) : null;
  const renderWorkflowActions = (context?: ComposerFooterContext) => {
    if (!canResolve) return null;
    const disabled = context ? !context.canRunAction : false;
    const runResolve = (resolved: boolean) => {
      if (context) {
        void context.submitAction((body, name) => onResolve(group.top.id, resolved, body, name));
      } else {
        void onResolve(group.top.id, resolved);
      }
    };

    return (
      <Flex gap="2" align="center" wrap="wrap" className="thread-workflow-actions">
        {isResolved ? (
          <Button
            size="1"
            variant="soft"
            color="gray"
            disabled={disabled}
            onClick={() => runResolve(false)}
          >
            Reopen
          </Button>
        ) : (
          <Button
            size="1"
            variant="soft"
            color="green"
            className="thread-resolve-button"
            disabled={disabled}
            onClick={() => runResolve(true)}
          >
            Resolve thread
          </Button>
        )}
      </Flex>
    );
  };
  const standaloneWorkflowActions = renderWorkflowActions();

  const replyComposer = canComment ? (
    <div className="reply-composer">
      <CommentComposer
        ref={composerRef}
        mentionCandidates={mentionCandidates}
        placeholder="Reply…"
        needsName={needsName}
        rows={2}
        footerActions={canResolve ? renderWorkflowActions : undefined}
        onSubmit={(body, name) => submitReply(group.top.id, body, name)}
      />
    </div>
  ) : standaloneWorkflowActions ? (
    <div className="reply-composer thread-workflow-only">
      {standaloneWorkflowActions}
    </div>
  ) : null;

  return (
    <DiscussionThread
      threadId={group.top.id}
      quote={group.top.anchor?.quote ?? null}
      quoteTitle="Jump to this location in the document"
      onJump={jump}
      summary={`${group.replies.length + 1} comment${group.replies.length === 0 ? '' : 's'}`}
      toolbarActions={toolbarActions}
      focused={threadFocused}
      flashPhase={threadFlashPhase}
      collapsed={collapsed}
      className={isResolved ? 'resolved' : undefined}
      onToggleCollapsed={onToggleCollapsed}
    >
      <>
        <CommentItem
          comment={group.top}
          isDocAdmin={isDocAdmin}
          onEdit={onEdit}
          onDelete={onDelete}
          onQuote={canComment ? handleQuote : undefined}
        />
        {group.replies.map((r) => (
          <CommentItem
            key={r.id}
            comment={r}
            isDocAdmin={isDocAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
            onQuote={canComment ? handleQuote : undefined}
          />
        ))}
        {replyComposer}
      </>
    </DiscussionThread>
  );
}

function groupByAnchor(
  comments: Comment[],
  sortMode: CommentSortMode,
): { active: AnchorGroup[]; orphans: AnchorGroup[] } {
  const tops = new Map<string, AnchorGroup>();
  const replies: Comment[] = [];
  for (const c of comments) {
    if (c.parent_id) replies.push(c);
    else tops.set(c.id, { top: c, replies: [] });
  }
  for (const r of replies) {
    const parent = r.parent_id ? tops.get(r.parent_id) : undefined;
    if (parent) parent.replies.push(r);
  }
  const active: AnchorGroup[] = [];
  const orphans: AnchorGroup[] = [];
  for (const g of tops.values()) {
    if (g.top.link_status === 'orphaned') orphans.push(g);
    else active.push(g);
  }
  const sortGroups =
    sortMode === 'latest' ? compareGroupsByLatestActivityDesc : compareGroupsByDocumentOrder;
  active.sort(sortGroups);
  orphans.sort(sortGroups);
  return { active, orphans };
}

function groupProposalThreads(
  proposals: EditProposal[],
  proposalReplies: Map<string, Comment[]>,
): { active: ProposalThread[]; orphans: ProposalThread[] } {
  const active: ProposalThread[] = [];
  const orphans: ProposalThread[] = [];
  for (const proposal of proposals) {
    const thread = { proposal, replies: proposalReplies.get(proposal.id) ?? [] };
    if (proposal.comment.link_status === 'orphaned' && proposal.status !== 'accepted') {
      orphans.push(thread);
    } else active.push(thread);
  }
  return { active, orphans };
}
function combineThreads(
  commentGroups: AnchorGroup[],
  proposalThreads: ProposalThread[],
  sortMode: CommentSortMode,
  blockOrder: Map<string, number>,
): ThreadListItem[] {
  const threads = [
    ...commentGroups.map((group) => ({
      kind: 'comment' as const,
      id: group.top.id,
      createdAt: group.top.created_at,
      latestActivityAt: latestActivityTs(group),
      anchor: anchorOrderFromComment(group.top.anchor),
      group,
    })),
    ...proposalThreads.map((thread) => ({
      kind: 'proposal' as const,
      id: thread.proposal.id,
      createdAt: thread.proposal.comment.created_at,
      latestActivityAt: proposalLatestActivityTs(thread),
      anchor: anchorOrderFromProposal(thread.proposal),
      thread,
    })),
  ];
  threads.sort((a, b) =>
    sortMode === 'latest'
      ? compareThreadsByLatestActivityDesc(a, b)
      : compareThreadsByDocumentOrder(a, b, blockOrder),
  );
  return threads;
}

function compareGroupsByLatestActivityDesc(a: AnchorGroup, b: AnchorGroup): number {
  return latestActivityTs(b) - latestActivityTs(a) || a.top.created_at - b.top.created_at;
}

function compareGroupsByDocumentOrder(a: AnchorGroup, b: AnchorGroup): number {
  const pathCmp = compareAnchorPaths(a.top.anchor, b.top.anchor);
  if (pathCmp !== 0) return pathCmp;
  const offsetCmp = compareNullableNumber(
    a.top.anchor?.start_offset ?? null,
    b.top.anchor?.start_offset ?? null,
  );
  if (offsetCmp !== 0) return offsetCmp;
  return a.top.created_at - b.top.created_at;
}

function compareThreadsByLatestActivityDesc(a: ThreadListItem, b: ThreadListItem): number {
  return b.latestActivityAt - a.latestActivityAt || a.createdAt - b.createdAt;
}

function compareThreadsByDocumentOrder(
  a: ThreadListItem,
  b: ThreadListItem,
  blockOrder: Map<string, number>,
): number {
  const anchorCmp = compareThreadAnchorOrder(a.anchor, b.anchor, blockOrder);
  if (anchorCmp !== 0) return anchorCmp;
  return a.createdAt - b.createdAt;
}

function compareAnchorPaths(a: CommentAnchor | null, b: CommentAnchor | null): number {
  const aPath = normalizeAnchorPath(a);
  const bPath = normalizeAnchorPath(b);
  return compareNumberArrays(aPath, bPath);
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

function normalizeAnchorPath(anchor: CommentAnchor | null): number[] {
  if (anchor?.section_index_path && anchor.section_index_path.length > 0) {
    return anchor.section_index_path;
  }
  if (typeof anchor?.section_index === 'number') return [anchor.section_index];
  return [];
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

function latestActivityTs(group: AnchorGroup): number {
  let latest = group.top.created_at;
  for (const reply of group.replies) {
    if (reply.created_at > latest) latest = reply.created_at;
  }
  return latest;
}

function proposalLatestActivityTs(thread: ProposalThread): number {
  let latest = thread.proposal.comment.updated_at;
  for (const reply of thread.replies) {
    if (reply.created_at > latest) latest = reply.created_at;
  }
  return latest;
}

function shouldThreadAutoCollapse(thread: ThreadListItem): boolean {
  if (thread.kind === 'comment') return thread.group.top.resolved_at !== null;
  return thread.thread.proposal.comment.resolved_at !== null;
}

function anchorOrderFromComment(anchor: CommentAnchor | null): ThreadAnchorOrder {
  return {
    blockId: anchor?.block_id ?? null,
    sectionIndex: typeof anchor?.section_index === 'number' ? anchor.section_index : null,
    sectionIndexPath: anchor?.section_index_path ?? [],
    startOffset: typeof anchor?.start_offset === 'number' ? anchor.start_offset : null,
  };
}

function anchorOrderFromProposal(proposal: EditProposal): ThreadAnchorOrder {
  return {
    blockId: proposal.comment.anchor?.block_id ?? null,
    sectionIndex: null,
    sectionIndexPath: [],
    startOffset: null,
  };
}
