import type { Database } from 'bun:sqlite';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
} from '@marginalia/renderer';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentRow, EditProposalThreadRow } from '../db.js';
import type { Realtime } from '../realtime.js';
import type { AppDeps } from './documents.js';
import { toWire as toCommentWire } from './comments.js';

/**
 * Shared proposal helpers.
 *
 * Proposal routes now live on `threadsRouter`. This module still owns the
 * proposal-specific DB and reanchoring helpers because document history and
 * thread workflows reuse them.
 */

const PROPOSAL_SELECT = `
  SELECT
    c.*,
    cep.anchor_kind,
    cep.source_snapshot,
    cep.proposed_text,
    cep.status AS proposal_status,
    cep.accepted_oid,
    cep.branch_ref,
    cep.base_oid,
    cep.base_block_start,
    cep.base_block_end,
    c.resolved_at AS decided_at,
    c.resolved_by_name AS decided_by_name
  FROM comments c
  INNER JOIN comments_edit_proposals cep ON cep.comment_id = c.id
`;

/**
 * Mark any open proposal whose root-comment anchor block is no longer present
 * as orphaned, null out its `anchor_block_id` so clients stop offering
 * jump-to-anchor against a stale id, and broadcast `edit_proposal.updated`
 * for each one so UIs update live. Used after any source edit (proposal
 * acceptance or direct save).
 *
 * Returns the now-orphaned proposal rows (post-update) for callers that need
 * to do more with them.
 */
export function reanchorProposals(
  db: Database,
  docUid: string,
  presentBlockIds: string[],
  now: number,
  realtime?: Realtime,
  exceptClientId?: string,
): EditProposalThreadRow[] {
  const present = new Set(presentBlockIds);
  const open = db
    .prepare(
      `${PROPOSAL_SELECT}
       WHERE c.doc_uid = ? AND cep.status = 'open' AND c.deleted_at IS NULL`,
    )
    .all(docUid) as EditProposalThreadRow[];
  const markComment = db.prepare(
    `UPDATE comments
        SET link_status = 'orphaned', anchor_block_id = NULL, updated_at = ?
      WHERE id = ?`,
  );
  const orphaned: EditProposalThreadRow[] = [];
  for (const p of open) {
    if (!p.anchor_block_id || !present.has(p.anchor_block_id)) {
      markComment.run(now, p.id);
      const fresh = loadProposalRow(db, p.id, docUid);
      if (fresh) {
        orphaned.push(fresh);
        if (realtime) {
          realtime.broadcast(
            docUid,
            { type: 'edit_proposal.updated', edit_proposal: toWire(fresh) },
            exceptClientId,
          );
        }
      }
    }
  }
  return orphaned;
}

export function loadProposalRow(
  db: Database,
  proposalId: string,
  docUid: string,
): EditProposalThreadRow | undefined {
  return db
    .prepare(
      `${PROPOSAL_SELECT}
      WHERE c.id = ? AND c.doc_uid = ? AND c.deleted_at IS NULL`,
    )
    .get(proposalId, docUid) as EditProposalThreadRow | undefined;
}

export function reopenAcceptedProposal(
  db: Database,
  docUid: string,
  proposalId: string,
  now: number,
): EditProposalThreadRow | null {
  const row = loadProposalRow(db, proposalId, docUid);
  if (!row) return null;
  if (row.proposal_status !== 'accepted') return null;

  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'open', accepted_oid = NULL
      WHERE comment_id = ?`,
  ).run(proposalId);
  db.prepare(
    `UPDATE comments
        SET resolved_at = NULL, resolved_by_name = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(now, proposalId);

  return loadProposalRow(db, proposalId, docUid) ?? null;
}

export async function resolveProposalDiffBefore(
  doc: DocumentRow,
  proposal: EditProposalThreadRow,
  deps: AppDeps,
): Promise<string> {
  const snapshot = proposal.source_snapshot ?? proposal.anchor_quote ?? '';

  if (proposal.proposal_status !== 'accepted') {
    const liveSource = deps.store.read(doc);
    const liveBlock = readProposalBlockSource(doc, liveSource, proposal.anchor_block_id);
    if (!liveBlock) return snapshot;
    if (liveBlock === proposal.proposed_text && snapshot !== proposal.proposed_text)
      return snapshot;
    return liveBlock;
  }

  if (proposal.source_snapshot) return proposal.source_snapshot;

  const repaired = await resolveAcceptedProposalSnapshot(doc, proposal, deps);
  return repaired ?? snapshot;
}

async function resolveAcceptedProposalSnapshot(
  doc: DocumentRow,
  proposal: EditProposalThreadRow,
  deps: AppDeps,
): Promise<string | null> {
  if (!proposal.anchor_block_id) return null;

  const exact = proposal.accepted_oid
    ? await readAcceptedProposalSnapshotAtCommit(doc, proposal, proposal.accepted_oid, deps)
    : null;
  if (exact) {
    persistResolvedProposalSnapshot(deps.db, proposal.id, exact, proposal.accepted_oid);
    return exact;
  }

  if (!proposal.decided_at) return null;

  const history = await deps.store.history(doc);
  const candidates = history
    .filter((entry) => entry.message.startsWith('accept-proposal:'))
    .sort(
      (a, b) =>
        Math.abs(a.timestamp - proposal.decided_at!) - Math.abs(b.timestamp - proposal.decided_at!),
    );

  for (const entry of candidates) {
    const snapshot = await readAcceptedProposalSnapshotAtCommit(doc, proposal, entry.oid, deps);
    if (!snapshot) continue;
    persistResolvedProposalSnapshot(deps.db, proposal.id, snapshot, entry.oid);
    return snapshot;
  }

  return null;
}

async function readAcceptedProposalSnapshotAtCommit(
  doc: DocumentRow,
  proposal: EditProposalThreadRow,
  acceptedOid: string,
  deps: AppDeps,
): Promise<string | null> {
  const diff = await deps.store.diffAt(doc, acceptedOid);
  if (!diff) return null;

  // Fast path: block ID is stable across the accept — find the pre-accept source
  // directly by the same block ID in the before-snapshot.
  const before = readProposalBlockSource(doc, diff.before, proposal.anchor_block_id);
  if (before) {
    if (!diff.after.includes(proposal.proposed_text)) return null;
    return before;
  }

  // Fallback: the block ID changed across the accept commit (block IDs are
  // derived from content, so replacing content changes the ID). We recover the
  // pre-accept text by locating the accepted block in the *after* snapshot to
  // get its character span, then using findBlockBySourceSpan to find whichever
  // block occupied that same span in the *before* snapshot. This works because
  // accepting a proposal replaces a block's content in-place: the byte offsets
  // of the surrounding blocks are unchanged, so the pre-accept block sits at
  // exactly the position the post-accept block now occupies.
  const afterRanges = locateDocumentBlocks(doc, diff.after);
  const afterRange = proposal.anchor_block_id ? afterRanges.get(proposal.anchor_block_id) : null;
  if (!afterRange) return null;
  const beforeRanges = locateDocumentBlocks(doc, diff.before);
  const previousRange = findBlockBySourceSpan(beforeRanges, afterRange.start, afterRange.end);
  if (!previousRange) return null;
  if (!diff.after.includes(proposal.proposed_text)) return null;
  return diff.before.slice(previousRange.range.start, previousRange.range.end);
}

function persistResolvedProposalSnapshot(
  db: Database,
  proposalId: string,
  snapshot: string,
  acceptedOid: string | null,
): void {
  db.prepare(
    `UPDATE comments_edit_proposals
        SET source_snapshot = COALESCE(source_snapshot, ?),
            accepted_oid = COALESCE(accepted_oid, ?)
      WHERE comment_id = ?`,
  ).run(snapshot, acceptedOid, proposalId);
}

function readProposalBlockSource(
  doc: DocumentRow,
  source: string,
  blockId: string | null,
): string | null {
  if (!blockId) return null;
  const range =
    locateDocumentBlocks(doc, source).get(blockId) ??
    (doc.format === 'asciidoc' ? null : locateBlockSource(source, blockId));
  return range ? source.slice(range.start, range.end) : null;
}

export function locateDocumentBlocks(doc: DocumentRow, source: string): Map<string, BlockSourceRange> {
  return doc.format === 'asciidoc' ? locateAllBlocksAsciidoc(source) : locateAllBlocks(source);
}

export function findBlockBySourceSpan(
  blocks: Map<string, BlockSourceRange>,
  start: number,
  end: number,
): { id: string; range: BlockSourceRange; confidence: 'linked' | 'low-confidence' } | null {
  let exact: { id: string; range: BlockSourceRange } | null = null;
  let sameStart: { id: string; range: BlockSourceRange } | null = null;
  let container: { id: string; range: BlockSourceRange } | null = null;
  let overlap:
    | { id: string; range: BlockSourceRange; amount: number; span: number }
    | null = null;

  for (const [id, range] of blocks) {
    if (range.start === start && range.end === end) {
      exact = { id, range };
      break;
    }
    if (range.start === start) {
      if (!sameStart || Math.abs(range.end - end) < Math.abs(sameStart.range.end - end)) {
        sameStart = { id, range };
      }
    }
    if (range.start <= start && range.end >= end) {
      if (!container || range.end - range.start < container.range.end - container.range.start) {
        container = { id, range };
      }
    }
    const amount = Math.min(range.end, end) - Math.max(range.start, start);
    if (amount > 0) {
      const span = range.end - range.start;
      if (!overlap || amount > overlap.amount || (amount === overlap.amount && span < overlap.span)) {
        overlap = { id, range, amount, span };
      }
    }
  }

  if (exact) return { ...exact, confidence: 'linked' };
  if (sameStart) return { ...sameStart, confidence: 'linked' };
  if (container) return { ...container, confidence: 'linked' };
  if (overlap) return { id: overlap.id, range: overlap.range, confidence: 'low-confidence' };
  return null;
}

export function toWire(row: EditProposalThreadRow): Record<string, unknown> {
  return {
    id: row.id,
    comment: toCommentWire(row),
    anchor_kind: row.anchor_kind,
    source_snapshot: row.source_snapshot,
    proposed_text: row.proposed_text,
    status: row.proposal_status,
    decided_at: row.decided_at,
    decided_by_name: row.decided_by_name,
  };
}
