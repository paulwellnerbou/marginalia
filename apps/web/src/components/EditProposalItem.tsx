import { useMemo, useState } from 'react';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { EditProposal } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';
import { ConfirmButton } from './ConfirmButton.js';
import { DiffDialog } from './DiffDialog.js';

interface Props {
  proposal: EditProposal;
  /** Current doc source — used by the diff to show the live original. */
  docSource: string;
  /** Precomputed block-id → source-range map for the current doc source.
   *  Shared across all proposal items to avoid per-item markdown re-parses. */
  blockRanges: Map<string, BlockSourceRange>;
  /** Viewer has edit rights (admin or editor). */
  canEdit: boolean;
  isDocAdmin: boolean;
  onAccept: (id: string) => Promise<void> | void;
  onReject: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onScrollToAnchor: (blockId: string) => void;
}

export function EditProposalItem({
  proposal, docSource, blockRanges, canEdit, isDocAdmin,
  onAccept, onReject, onDelete, onScrollToAnchor,
}: Props) {
  const [diffOpen, setDiffOpen] = useState(false);
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

      <Flex align="center" gap="2" className="thread-toolbar" wrap="wrap">
        {statusBadge}
        <Text size="1" color="gray">by {proposal.author.display_name}</Text>
        <span className="spacer" />
        <Button size="1" variant="soft" onClick={() => setDiffOpen(true)}>
          Show diff
        </Button>
      </Flex>

      {proposal.rationale && (
        <Text as="p" size="2" className="proposal-rationale">
          {proposal.rationale}
        </Text>
      )}

      <Flex gap="2" align="center" mt="1" wrap="wrap">
        {proposal.status === 'pending' && canEdit && (
          <>
            <Button
              size="1"
              color="green"
              variant="soft"
              onClick={() => onAccept(proposal.id)}
            >
              Accept
            </Button>
            <ConfirmButton
              label="Reject"
              confirmLabel="Confirm reject"
              onConfirm={() => onReject(proposal.id)}
            />
          </>
        )}
        {(isAuthor || isDocAdmin) && proposal.status !== 'accepted' && (
          <ConfirmButton
            label="Delete"
            confirmLabel="Confirm delete"
            onConfirm={() => onDelete(proposal.id)}
          />
        )}
      </Flex>

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
