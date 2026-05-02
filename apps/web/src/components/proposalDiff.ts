import type { BlockSourceRange } from '@marginalia/renderer';
import type { Thread, ThreadProposalData } from '../lib/api.js';
import { mergeBlockRanges } from './mergeBlockRanges.js';

interface ResolveProposalDiffBeforeArgs {
  thread: Thread & { proposal: ThreadProposalData };
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
}

export function resolveProposalDiffBefore({
  thread,
  docSource,
  blockRanges,
}: ResolveProposalDiffBeforeArgs): string {
  const { proposal } = thread;
  const quoteSnapshot = proposal.source_snapshot ?? thread.anchor.quote ?? '';

  const isAccepted = thread.state === 'resolved' && thread.resolution?.kind === 'accept';
  if (isAccepted && quoteSnapshot.length > 0) {
    return quoteSnapshot;
  }

  const blockId = thread.anchor.block_id;
  if (!blockId) return quoteSnapshot;

  const range = mergeBlockRanges(blockRanges, blockId, thread.anchor.end_block_id ?? null);
  if (!range) return quoteSnapshot;

  const liveSource = docSource.slice(range.start, range.end);

  if (liveSource === proposal.proposed_text && quoteSnapshot !== proposal.proposed_text) {
    return quoteSnapshot;
  }

  return liveSource;
}
