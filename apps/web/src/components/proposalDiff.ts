import type { BlockSourceRange } from '@marginalia/renderer';
import type { EditProposal } from '../lib/api.js';

interface ResolveProposalDiffBeforeArgs {
  proposal: EditProposal;
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
}

export function resolveProposalDiffBefore({
  proposal,
  docSource,
  blockRanges,
}: ResolveProposalDiffBeforeArgs): string {
  const quoteSnapshot = proposal.source_snapshot ?? proposal.anchor.quote ?? '';

  // Accepted proposals should keep showing the original snapshot even
  // after the live document has been updated to the proposed text.
  if (proposal.status === 'accepted' && quoteSnapshot.length > 0) {
    return quoteSnapshot;
  }

  const blockId = proposal.anchor.block_id;
  if (!blockId) return quoteSnapshot;

  const range = blockRanges.get(blockId);
  if (!range) return quoteSnapshot;

  const liveSource = docSource.slice(range.start, range.end);

  // If the current block already matches the proposal, prefer the saved
  // snapshot so the diff still shows what changed.
  if (liveSource === proposal.proposed_text && quoteSnapshot !== proposal.proposed_text) {
    return quoteSnapshot;
  }

  return liveSource;
}
