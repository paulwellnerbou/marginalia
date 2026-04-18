import { useMemo, useState } from 'react';
import { Badge, Button, Flex, IconButton, Text, TextArea, Tooltip } from '@radix-ui/themes';
import {
  ChatBubbleIcon,
  EyeOpenIcon,
  Pencil2Icon,
} from '@radix-ui/react-icons';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { Comment, EditProposal } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { ConfirmButton } from './ConfirmButton.js';
import { CommentItem } from './CommentItem.js';
import { DiffDialog } from './DiffDialog.js';

interface Props {
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
  isDocAdmin: boolean;
  onAccept: (id: string) => Promise<void> | void;
  onReject: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onEditRationale: (id: string, rationale: string | null) => Promise<void> | void;
  onReply: (proposalId: string, body: string) => Promise<void> | void;
  onEditReply: (commentId: string, body: string) => Promise<void> | void;
  onDeleteReply: (commentId: string) => Promise<void> | void;
  onScrollToAnchor: (blockId: string) => void;
}

export function EditProposalItem({
  proposal, replies, docSource, blockRanges, canEdit, canComment, isDocAdmin,
  onAccept, onReject, onDelete, onEditRationale, onReply, onEditReply, onDeleteReply,
  onScrollToAnchor,
}: Props) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [editingRationale, setEditingRationale] = useState(false);
  const [replying, setReplying] = useState(false);
  const myId = getClientId();
  const isAuthor = proposal.author.client_id === myId;

  const originalSource = useMemo(() => {
    if (!proposal.anchor.block_id) return proposal.anchor.quote ?? '';
    const range = blockRanges.get(proposal.anchor.block_id);
    if (range) return docSource.slice(range.start, range.end);
    // Fall back to the quoted snapshot captured at creation time.
    return proposal.anchor.quote ?? '';
  }, [docSource, blockRanges, proposal.anchor.block_id, proposal.anchor.quote]);

  const blockId = proposal.anchor.block_id;
  const jump = blockId ? () => onScrollToAnchor(blockId) : undefined;

  const statusBadge = (() => {
    switch (proposal.status) {
      case 'pending':
        return <Badge color="blue" variant="soft">Proposed change</Badge>;
      case 'accepted':
        return (
          <Badge color="green" variant="soft">
            Accepted{proposal.decided_by_name ? ` by ${proposal.decided_by_name}` : ''}
          </Badge>
        );
      case 'rejected':
        return (
          <Badge color="red" variant="soft">
            Rejected{proposal.decided_by_name ? ` by ${proposal.decided_by_name}` : ''}
          </Badge>
        );
      case 'orphaned':
        return <Badge color="gray" variant="soft">Orphaned</Badge>;
    }
  })();

  const canDelete =
    (isAuthor || isDocAdmin) &&
    (proposal.status !== 'accepted' || isDocAdmin);

  return (
    <div className={`anchor-group proposal proposal-${proposal.status}`}>
      {proposal.anchor.quote && (
        <button
          type="button"
          className="anchor-quote"
          title="Jump to this paragraph"
          onClick={jump}
          disabled={!jump}
        >
          <span className="jump-icon" aria-hidden>↗</span>
          “{proposal.anchor.quote.slice(0, 120)}{proposal.anchor.quote.length > 120 ? '…' : ''}”
        </button>
      )}

      {/* Mirror CommentItem's meta line: author, status, action icons. */}
      <Flex align="center" gap="2" mb="1" className="comment-meta">
        <Text weight="medium" size="2" className="comment-author">
          {proposal.author.display_name}
        </Text>
        {statusBadge}
        <span className="spacer" />
        <Flex gap="1" align="center" wrap="wrap" className="comment-actions comment-actions-inline">
          {isAuthor && proposal.status === 'pending' && !editingRationale && (
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
          {canComment && !replying && (
            <Tooltip content="Reply">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Reply"
                onClick={() => setReplying(true)}
              >
                <ChatBubbleIcon />
              </IconButton>
            </Tooltip>
          )}
          {canDelete && (
            <ConfirmButton
              label="Delete"
              confirmLabel="Confirm delete"
              ariaLabel="Delete"
              onConfirm={() => onDelete(proposal.id)}
            />
          )}
        </Flex>
      </Flex>

      <div className="comment-surface">
        {editingRationale ? (
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
        ) : null}
      </div>

      {/* Single-line review action bar: Show diff / Accept / Reject. */}
      <Flex gap="2" align="center" mt="2" wrap="wrap" className="proposal-review-actions">
        <Button size="1" variant="soft" onClick={() => setDiffOpen(true)}>
          <EyeOpenIcon /> Show diff
        </Button>
        {proposal.status === 'pending' && canEdit && (
          <>
            <Button size="1" color="green" variant="soft" onClick={() => onAccept(proposal.id)}>
              Accept
            </Button>
            <ConfirmButton
              label="Reject"
              confirmLabel="Confirm reject"
              onConfirm={() => onReject(proposal.id)}
            />
          </>
        )}
      </Flex>

      {replies.length > 0 && (
        <div className="proposal-replies">
          {replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              isDocAdmin={isDocAdmin}
              onEdit={onEditReply}
              onDelete={onDeleteReply}
            />
          ))}
        </div>
      )}

      {replying && (
        <div className="proposal-reply-composer">
          <ReplyComposer
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await onReply(proposal.id, body);
              setReplying(false);
            }}
          />
        </div>
      )}

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="Proposed change"
        before={originalSource}
        after={proposal.proposed_text}
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
    </div>
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
      <Flex gap="3" justify="end" align="center" wrap="wrap" className="comment-actions comment-edit-actions">
        <Button size="1" variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button size="1" variant="soft" onClick={() => onSave(value)}>Save</Button>
      </Flex>
    </div>
  );
}

function ReplyComposer({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const ready = value.trim().length > 0;
  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim());
      setValue('');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="comment-edit">
      <TextArea
        className="comment-edit-field"
        size="1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="Reply…"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (ready && !submitting) void send();
          }
        }}
      />
      <Flex gap="3" justify="end" align="center" wrap="wrap" className="comment-actions comment-edit-actions">
        <Button size="1" variant="soft" color="gray" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="1" variant="soft" disabled={!ready || submitting} onClick={send}>
          {submitting ? 'Posting…' : 'Post reply'}
        </Button>
      </Flex>
    </div>
  );
}
