import { useMemo, useRef, useState, type RefObject } from 'react';
import { Badge, Button, Flex, IconButton, Text, TextArea, Tooltip } from '@radix-ui/themes';
import { Pencil2Icon, QuoteIcon } from '@radix-ui/react-icons';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { Thread, ThreadProposalData } from '../lib/api.js';
import { getEditProposalDiff, isProposal, proposalStatus } from '../lib/api.js';
import { reportError } from '../lib/log.js';
import {
  CommentComposer,
  type ComposerFooterContext,
  type ComposerHandle,
} from './ThreadComposer.js';
import { CommentItem } from './CommentItem.js';
import { ConfirmButton } from './ConfirmButton.js';
import { DiscussionEntry, DiscussionThread } from './DiscussionUi.js';
import { DiffDialog } from './DiffDialog.js';
import { resolveProposalDiffBefore } from './proposalDiff.js';
import { ShowDiffButton } from './ShowDiffButton.js';

interface Props {
  uid: string;
  thread: Thread;
  canComment: boolean;
  mentionCandidates: string[];
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  threadFocused: boolean;
  threadFlashPhase?: 'a' | 'b' | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEditBody: (nodeId: string, body: string) => Promise<void>;
  onDeleteNode: (nodeId: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onResolveThread: (
    threadId: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<void>;
  onEditRationale: (id: string, rationale: string | null) => Promise<void>;
  onScrollToAnchor: (blockId: string) => void;
}

export function ThreadItem(props: Props) {
  const composerRef = useRef<ComposerHandle>(null);
  const { thread, canComment, onScrollToAnchor } = props;

  const handleQuote = (text: string) => {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    composerRef.current?.insertText(quoted);
  };

  const blockId = thread.anchor.block_id;
  const jump = blockId ? () => onScrollToAnchor(blockId) : undefined;

  if (isProposal(thread)) {
    return (
      <ProposalThreadItem
        {...props}
        thread={thread}
        jump={jump}
        composerRef={composerRef}
        handleQuote={handleQuote}
      />
    );
  }

  const {
    mentionCandidates,
    needsName,
    threadFocused,
    threadFlashPhase,
    collapsed,
    onToggleCollapsed,
    onReply,
    onEditBody,
    onDeleteNode,
    onDeleteThread,
    onResolveThread,
  } = props;

  const isResolved = thread.state === 'resolved';
  const canResolve = isResolved ? thread.capabilities.reopen : thread.capabilities.resolve;

  const toolbarActions = isResolved ? (
    <Badge color="green" variant="soft">
      Resolved{thread.resolution?.by_name ? ` by ${thread.resolution.by_name}` : ''}
    </Badge>
  ) : null;

  const renderWorkflowActions = (context?: ComposerFooterContext) => {
    if (!canResolve) return null;
    const disabled = context ? !context.canRunAction : false;
    const runResolve = (kind: 'resolve' | 'reopen') => {
      if (context) {
        void context.submitAction((body, name) =>
          onResolveThread(thread.id, kind, body, name),
        );
      } else {
        void onResolveThread(thread.id, kind);
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
            onClick={() => runResolve('reopen')}
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
            onClick={() => runResolve('resolve')}
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
        onSubmit={(body, name) => onReply(thread.id, body, name)}
      />
    </div>
  ) : standaloneWorkflowActions ? (
    <div className="reply-composer thread-workflow-only">{standaloneWorkflowActions}</div>
  ) : null;

  return (
    <DiscussionThread
      threadId={thread.id}
      quote={thread.anchor.quote}
      quoteTitle="Jump to this location in the document"
      onJump={jump}
      summary={`${thread.replies.length + 1} comment${thread.replies.length === 0 ? '' : 's'}`}
      toolbarActions={toolbarActions}
      focused={threadFocused}
      flashPhase={threadFlashPhase}
      collapsed={collapsed}
      className={isResolved ? 'resolved' : undefined}
      onToggleCollapsed={onToggleCollapsed}
    >
      <>
        <CommentItem
          node={thread.root}
          onEdit={onEditBody}
          onDelete={() => onDeleteThread(thread.id)}
          onQuote={canComment ? handleQuote : undefined}
        />
        {thread.replies.map((r) => (
          <CommentItem
            key={r.id}
            node={r}
            onEdit={onEditBody}
            onDelete={onDeleteNode}
            onQuote={canComment ? handleQuote : undefined}
          />
        ))}
        {replyComposer}
      </>
    </DiscussionThread>
  );
}

// ---------------------------------------------------------------------------
// Proposal thread sub-component
// ---------------------------------------------------------------------------

function ProposalThreadItem({
  uid,
  thread,
  canComment,
  mentionCandidates,
  docSource,
  blockRanges,
  needsName,
  threadFocused,
  threadFlashPhase,
  collapsed,
  onToggleCollapsed,
  onReply,
  onEditBody,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onEditRationale,
  jump,
  composerRef,
  handleQuote,
}: Props & {
  thread: Thread & { proposal: ThreadProposalData };
  jump: (() => void) | undefined;
  composerRef: RefObject<ComposerHandle | null>;
  handleQuote: (text: string) => void;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [editingRationale, setEditingRationale] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const { proposal } = thread;
  const status = proposalStatus(thread);
  const isOpen = status === 'open';
  const isOrphaned =
    thread.link_status === 'orphaned' && status !== 'accepted';

  const originalSource = useMemo(
    () => resolveProposalDiffBefore({ thread, docSource, blockRanges }),
    [thread, docSource, blockRanges],
  );

  const diffBefore = resolvedDiff?.before ?? originalSource;
  const diffAfter = resolvedDiff?.after ?? proposal.proposed_text;

  const canDelete = thread.root.capabilities.delete;
  const canEditRationale = thread.root.capabilities.edit && isOpen && !editingRationale;

  const anchorLabel = formatAnchorLabel(thread.anchor.quote, proposal.source_snapshot);
  const quoteBody = (thread.root.body || proposal.proposed_text).trim();
  const handleReplyQuote = canComment ? (text: string) => handleQuote(text) : undefined;

  async function handleShowDiff(): Promise<void> {
    if (loadingDiff) return;
    setDiffError(null);

    if (status === 'accepted' && !proposal.source_snapshot) {
      if (resolvedDiff) {
        setDiffOpen(true);
        return;
      }
      setLoadingDiff(true);
      try {
        const diff = await getEditProposalDiff(uid, thread.id);
        setResolvedDiff(diff);
        setDiffOpen(true);
      } catch (err) {
        reportError('ThreadItem.getEditProposalDiff', err, { uid, threadId: thread.id });
        setDiffError('Could not load diff');
      } finally {
        setLoadingDiff(false);
      }
      return;
    }

    setResolvedDiff(null);
    setDiffOpen(true);
  }

  const headerBadges = (
    <Flex gap="1" align="center" wrap="wrap">
      <Badge variant="soft">Proposed change</Badge>
      {status === 'accepted' && (
        <Badge color="green" variant="soft">
          Accepted{thread.resolution?.by_name ? ` by ${thread.resolution.by_name}` : ''}
        </Badge>
      )}
      {status === 'rejected' && (
        <Badge color="red" variant="soft">
          Rejected{thread.resolution?.by_name ? ` by ${thread.resolution.by_name}` : ''}
        </Badge>
      )}
      {isOrphaned && <Badge color="gray" variant="soft">Orphaned</Badge>}
    </Flex>
  );

  const toolbarActions = (
    <Flex gap="2" align="center" wrap="wrap">
      <ShowDiffButton onClick={() => void handleShowDiff()} loading={loadingDiff} />
      {diffError ? <Text size="1" color="red">{diffError}</Text> : null}
    </Flex>
  );

  const canAccept = thread.capabilities.accept;
  const canReject = thread.capabilities.reject;

  const renderWorkflowActions = (context?: ComposerFooterContext) => {
    if (!canAccept && !canReject) return null;
    const disabled = context ? !context.canRunAction : false;
    const runAction = (kind: 'accept' | 'reject') => {
      if (context) {
        void context.submitAction((body, name) => onResolveThread(thread.id, kind, body, name));
      } else {
        void onResolveThread(thread.id, kind);
      }
    };
    return (
      <Flex gap="2" align="center" wrap="wrap" className="thread-workflow-actions">
        {canAccept && (
          <Button
            size="1"
            color="green"
            variant="soft"
            disabled={disabled}
            onClick={() => runAction('accept')}
          >
            Accept
          </Button>
        )}
        {canReject && (
          <Button
            size="1"
            color="red"
            variant="soft"
            disabled={disabled}
            onClick={() => runAction('reject')}
          >
            Reject
          </Button>
        )}
      </Flex>
    );
  };
  const standaloneWorkflowActions = renderWorkflowActions();

  const rootActions = (
    <Flex gap="1" align="center" wrap="wrap" className="comment-actions comment-actions-inline">
      {!deleteArmed && canComment && quoteBody && (
        <Tooltip content="Quote">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label="Quote"
            onClick={() => handleQuote(quoteBody)}
          >
            <QuoteIcon />
          </IconButton>
        </Tooltip>
      )}
      {canEditRationale && (
        <Tooltip content="Edit reason">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label="Edit reason"
            onClick={() => setEditingRationale(true)}
          >
            <Pencil2Icon />
          </IconButton>
        </Tooltip>
      )}
      {canDelete && (
        <ConfirmButton
          label="Delete"
          confirmLabel="Confirm delete"
          ariaLabel="Delete"
          reserveWidth={false}
          onArmedChange={setDeleteArmed}
          onConfirm={() => onDeleteThread(thread.id)}
        />
      )}
    </Flex>
  );

  const rootSurface = editingRationale ? (
    <RationaleEditor
      initial={thread.root.body}
      onCancel={() => setEditingRationale(false)}
      onSave={async (v) => {
        await onEditRationale(thread.id, v.trim().length > 0 ? v.trim() : null);
        setEditingRationale(false);
      }}
    />
  ) : thread.root.body.trim() ? (
    <Text as="p" className="comment-body proposal-rationale">
      {thread.root.body}
    </Text>
  ) : (
    <Text as="p" className="comment-body proposal-rationale proposal-rationale-empty">
      Change proposal
    </Text>
  );

  return (
    <>
      <DiscussionThread
        threadId={thread.id}
        quote={anchorLabel}
        quoteTitle="Jump to this location in the document"
        onJump={jump}
        summary={formatThreadSummary(thread.replies.length)}
        toolbarActions={toolbarActions}
        headerBadge={headerBadges}
        focused={threadFocused}
        flashPhase={threadFlashPhase}
        collapsed={collapsed}
        className={`proposal proposal-${status}${isOrphaned ? ' proposal-orphaned' : ''}`}
        onToggleCollapsed={onToggleCollapsed}
      >
        <DiscussionEntry
          authorName={thread.root.author.display_name}
          authorId={thread.root.author.client_id}
          createdAt={thread.root.created_at}
          actions={rootActions}
          surface={rootSurface}
          className="proposal-entry"
        />
        {thread.replies.map((r) => (
          <CommentItem
            key={r.id}
            node={r}
            onEdit={onEditBody}
            onDelete={onDeleteNode}
            onQuote={handleReplyQuote}
          />
        ))}

        {canComment ? (
          <div className="reply-composer">
            <CommentComposer
              ref={composerRef}
              mentionCandidates={mentionCandidates}
              needsName={needsName}
              placeholder="Reply…"
              rows={2}
              footerActions={canAccept || canReject ? renderWorkflowActions : undefined}
              onSubmit={(body, name) => onReply(thread.id, body, name)}
            />
          </div>
        ) : standaloneWorkflowActions ? (
          <div className="reply-composer thread-workflow-only">{standaloneWorkflowActions}</div>
        ) : null}
      </DiscussionThread>

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="Proposed change"
        before={diffBefore}
        after={diffAfter}
        actions={
          canAccept || canReject ? (
            <>
              {canAccept && (
                <Button
                  size="2"
                  color="green"
                  onClick={async () => {
                    await onResolveThread(thread.id, 'accept');
                    setDiffOpen(false);
                  }}
                >
                  Accept
                </Button>
              )}
              {canReject && (
                <Button
                  size="2"
                  color="red"
                  variant="soft"
                  onClick={async () => {
                    await onResolveThread(thread.id, 'reject');
                    setDiffOpen(false);
                  }}
                >
                  Reject
                </Button>
              )}
            </>
          ) : null
        }
      />
    </>
  );
}

function RationaleEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (v: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="comment-edit">
      <TextArea
        className="comment-edit-field"
        size="1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="Reason for this change (optional)"
        autoFocus
      />
      <Flex
        gap="3"
        justify="end"
        align="center"
        wrap="wrap"
        className="comment-actions comment-edit-actions"
      >
        <Button size="1" variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="1" variant="soft" onClick={() => onSave(value)}>
          Save
        </Button>
      </Flex>
    </div>
  );
}

function formatAnchorLabel(
  quote: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  const raw = quote && quote.trim().length > 0 ? quote : fallback;
  const text = raw?.trim();
  if (!text) return null;
  return `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`;
}

function formatThreadSummary(replyCount: number): string {
  const total = replyCount + 1;
  return `${total} comment${total === 1 ? '' : 's'}`;
}
