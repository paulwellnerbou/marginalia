import { useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Badge, Button, Flex, IconButton, Text, TextArea, Tooltip } from '@radix-ui/themes';
import {
  Pencil2Icon,
  QuoteIcon,
} from '@radix-ui/react-icons';
import type { BlockSourceRange } from '@marginalia/renderer';
import { getEditProposalDiff, type Comment, type EditProposal } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { CommentComposer, type ComposerHandle } from './CommentComposer.js';
import { ConfirmButton } from './ConfirmButton.js';
import { CommentItem } from './CommentItem.js';
import { DiscussionEntry, DiscussionThread } from './DiscussionUi.js';
import { DiffDialog } from './DiffDialog.js';
import { resolveProposalDiffBefore } from './proposalDiff.js';
import { ShowDiffButton } from './ShowDiffButton.js';

interface Props {
  uid: string;
  proposal: EditProposal;
  /** Replies on this proposal (comments with parent_proposal_id === id). */
  replies: Comment[];
  /** Current doc source — used by the diff to show the live original. */
  docSource: string;
  /** Precomputed block-id → source-range map for the current doc source.
   *  Shared across all proposal items to avoid per-item markdown re-parses. */
  blockRanges: Map<string, BlockSourceRange>;
  /** Viewer has edit rights (admin or editor). */
  canEdit: boolean;
  /** Viewer may comment / reply. */
  canComment: boolean;
  mentionCandidates: string[];
  isDocAdmin: boolean;
  onAccept: (id: string) => Promise<void> | void;
  onReject: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onEditRationale: (id: string, rationale: string | null) => Promise<void> | void;
  onReply: (proposalId: string, body: string, name?: string) => Promise<void> | void;
  onEditReply: (commentId: string, body: string) => Promise<void> | void;
  onDeleteReply: (commentId: string) => Promise<void> | void;
  onScrollToAnchor: (blockId: string) => void;
  threadFocused: boolean;
  threadFlashPhase?: 'a' | 'b' | null;
  collapsed: boolean;
  needsName: boolean;
  onToggleCollapsed: () => void;
}

export function EditProposalItem({
  uid,
  proposal, replies, docSource, blockRanges, canEdit, canComment, mentionCandidates, isDocAdmin,
  onAccept, onReject, onDelete, onEditRationale, onReply, onEditReply, onDeleteReply,
  onScrollToAnchor, threadFocused, threadFlashPhase, collapsed, needsName,
  onToggleCollapsed,
}: Props) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [editingRationale, setEditingRationale] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const myId = getClientId();
  const isAuthor = proposal.author.client_id === myId;
  const composerRef = useRef<ComposerHandle>(null);

  const originalSource = useMemo(() => {
    return resolveProposalDiffBefore({ proposal, docSource, blockRanges });
  }, [proposal, docSource, blockRanges]);

  const blockId = proposal.anchor.block_id;
  const jump = blockId ? () => onScrollToAnchor(blockId) : undefined;
  const diffBefore = resolvedDiff?.before ?? originalSource;
  const diffAfter = resolvedDiff?.after ?? proposal.proposed_text;

  const headerBadges = (
    <Flex gap="1" align="center" wrap="wrap">
      <Badge variant="soft">Proposed change</Badge>
      {proposal.status === 'accepted' && (
        <Badge color="green" variant="soft">
          Accepted{proposal.decided_by_name ? ` by ${proposal.decided_by_name}` : ''}
        </Badge>
      )}
      {proposal.status === 'rejected' && (
        <Badge color="red" variant="soft">
          Rejected{proposal.decided_by_name ? ` by ${proposal.decided_by_name}` : ''}
        </Badge>
      )}
      {proposal.status === 'orphaned' && <Badge color="gray" variant="soft">Orphaned</Badge>}
    </Flex>
  );

  const canDelete =
    (isAuthor || isDocAdmin) &&
    (proposal.status !== 'accepted' || isDocAdmin);
  const quoteBody = (proposal.rationale ?? proposal.proposed_text).trim();
  const handleQuote = () => {
    if (!quoteBody) return;
    insertQuotedText(composerRef, quoteBody);
  };
  const handleReplyQuote = canComment
    ? (text: string) => insertQuotedText(composerRef, text)
    : undefined;

  async function handleShowDiff(): Promise<void> {
    if (loadingDiff) return;
    setDiffError(null);

    if (proposal.status === 'accepted' && !proposal.source_snapshot) {
      if (resolvedDiff) {
        setDiffOpen(true);
        return;
      }
      setLoadingDiff(true);
      try {
        const diff = await getEditProposalDiff(uid, proposal.id);
        setResolvedDiff(diff);
        setDiffOpen(true);
      } catch (err) {
        reportError('EditProposalItem.getEditProposalDiff', err, { uid, proposalId: proposal.id });
        setDiffError('Could not load diff');
      } finally {
        setLoadingDiff(false);
      }
      return;
    }

    setResolvedDiff(null);
    setDiffOpen(true);
  }

  const toolbarActions = (
    <Flex gap="2" align="center" wrap="wrap">
      <ShowDiffButton
        onClick={() => void handleShowDiff()}
        loading={loadingDiff}
      />
      {proposal.status === 'pending' && canEdit && (
        <>
          <Button size="1" color="green" variant="soft" onClick={() => onAccept(proposal.id)}>
            Accept
          </Button>
          <Button size="1" color="red" variant="soft" onClick={() => onReject(proposal.id)}>
            Reject
          </Button>
        </>
      )}
      {diffError ? <Text size="1" color="red">{diffError}</Text> : null}
    </Flex>
  );
  const actions = (
    <Flex gap="1" align="center" wrap="wrap" className="comment-actions comment-actions-inline">
      {!deleteArmed && canComment && quoteBody && (
        <Tooltip content="Quote">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label="Quote"
            onClick={handleQuote}
          >
            <QuoteIcon />
          </IconButton>
        </Tooltip>
      )}
      {!deleteArmed && isAuthor && proposal.status === 'pending' && !editingRationale && (
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
          onConfirm={() => onDelete(proposal.id)}
        />
      )}
    </Flex>
  );
  const surface = editingRationale ? (
    <RationaleEditor
      initial={proposal.rationale ?? ''}
      onCancel={() => setEditingRationale(false)}
      onSave={async (v) => {
        await onEditRationale(proposal.id, v.trim().length > 0 ? v.trim() : null);
        setEditingRationale(false);
      }}
    />
  ) : proposal.rationale ? (
    <Text as="p" className="comment-body proposal-rationale">
      {proposal.rationale}
    </Text>
  ) : (
    <Text as="p" className="comment-body proposal-rationale proposal-rationale-empty">
      Change proposal
    </Text>
  );

  return (
    <>
      <DiscussionThread
        threadId={proposal.id}
        quote={proposal.anchor.quote ? `${proposal.anchor.quote.slice(0, 120)}${proposal.anchor.quote.length > 120 ? '…' : ''}` : null}
        quoteTitle="Jump to this paragraph"
        onJump={jump}
        summary={formatThreadSummary(replies.length)}
        toolbarActions={toolbarActions}
        headerBadge={headerBadges}
        focused={threadFocused}
        flashPhase={threadFlashPhase}
        collapsed={collapsed}
        className={`proposal proposal-${proposal.status}`}
        onToggleCollapsed={onToggleCollapsed}
      >
        <DiscussionEntry
          authorName={proposal.author.display_name}
          authorId={proposal.author.client_id}
          createdAt={proposal.created_at}
          actions={actions}
          surface={surface}
          className="proposal-entry"
        />
        {replies.map((r) => (
          <CommentItem
            key={r.id}
            comment={r}
            isDocAdmin={isDocAdmin}
            onEdit={onEditReply}
            onDelete={onDeleteReply}
            onQuote={handleReplyQuote}
          />
        ))}

        {canComment && (
          <div className="reply-composer">
            <CommentComposer
              ref={composerRef}
              mentionCandidates={mentionCandidates}
              needsName={needsName}
              placeholder="Reply…"
              rows={2}
              onSubmit={(body, name) => onReply(proposal.id, body, name)}
            />
          </div>
        )}
      </DiscussionThread>
      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="Proposed change"
        before={diffBefore}
        after={diffAfter}
        actions={
          proposal.status === 'pending' && canEdit ? (
            <>
              <Button
                size="2"
                color="green"
                onClick={async () => {
                  await onAccept(proposal.id);
                  setDiffOpen(false);
                }}
              >
                Accept
              </Button>
              <Button
                size="2"
                color="red"
                variant="soft"
                onClick={async () => {
                  await onReject(proposal.id);
                  setDiffOpen(false);
                }}
              >
                Reject
              </Button>
            </>
          ) : null
        }
      />
    </>
  );
}

function insertQuotedText(
  composerRef: React.RefObject<ComposerHandle | null>,
  text: string,
): void {
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  composerRef.current?.insertText(quoted);
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
      <Flex gap="3" justify="end" align="center" wrap="wrap" className="comment-actions comment-edit-actions">
        <Button size="1" variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button size="1" variant="soft" onClick={() => onSave(value)}>Save</Button>
      </Flex>
    </div>
  );
}

function formatThreadSummary(replyCount: number): string {
  const total = replyCount + 1;
  return `${total} comment${total === 1 ? '' : 's'}`;
}
