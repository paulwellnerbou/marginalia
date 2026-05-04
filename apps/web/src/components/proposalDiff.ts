import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat, Thread, ThreadProposalData } from '../lib/api.js';
import { mergeBlockRanges } from './mergeBlockRanges.js';

interface ResolveProposalDiffBeforeArgs {
  thread: Thread & { proposal: ThreadProposalData };
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
  docFormat: DocumentFormat;
}

export function resolveProposalDiffBefore({
  thread,
  docSource,
  blockRanges,
  docFormat,
}: ResolveProposalDiffBeforeArgs): string {
  const { proposal } = thread;
  const quoteSnapshot = proposal.source_snapshot ?? thread.anchor.quote ?? '';

  const isAccepted = thread.state === 'resolved' && thread.resolution?.kind === 'accept';
  if (isAccepted && quoteSnapshot.length > 0) {
    return quoteSnapshot;
  }

  // Whole-document proposals replace the full source — diff "before" is
  // the live document (or, if the doc has moved on, the snapshot taken
  // when the proposal was created). Slicing a single block's range here
  // would make the rest of the document look like additions.
  if (proposal.whole_document) {
    return docSource.length > 0 ? docSource : quoteSnapshot;
  }

  const blockId = thread.anchor.block_id;
  if (!blockId) return quoteSnapshot;

  const range = mergeBlockRanges(blockRanges, blockId, thread.anchor.end_block_id ?? null, docFormat);
  if (!range) return quoteSnapshot;

  const liveSource = docSource.slice(range.start, range.end);

  if (liveSource === proposal.proposed_text && quoteSnapshot !== proposal.proposed_text) {
    return quoteSnapshot;
  }

  return liveSource;
}
