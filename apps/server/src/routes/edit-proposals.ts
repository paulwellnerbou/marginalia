import type { Database } from 'bun:sqlite';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentRow, EditProposalThreadRow } from '../db.js';
import type { GitStore } from '../git-store.js';
import type { Realtime } from '../realtime.js';
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
  broadcast?: (row: EditProposalThreadRow) => void,
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
        if (broadcast) broadcast(fresh);
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

export async function toWire(
  store: GitStore,
  doc: DocumentRow,
  row: EditProposalThreadRow,
): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    comment: toCommentWire(row),
    status: row.proposal_status,
    decided_at: row.decided_at,
    decided_by_name: row.decided_by_name,
    ...(await readProposalContent(store, doc, row)),
  };
}

/**
 * Recover the legacy `source_snapshot` + `proposed_text` fields from
 * the proposal's branch tip and base blob. Phase 4 will drop these from
 * the wire entirely; for now they're computed on-demand from git so
 * existing clients keep working after the column drop.
 */
export async function readProposalContent(
  store: GitStore,
  doc: DocumentRow,
  row: EditProposalThreadRow,
): Promise<{ source_snapshot: string; proposed_text: string }> {
  if (
    !row.branch_ref ||
    !row.base_oid ||
    row.base_block_start === null ||
    row.base_block_end === null
  ) {
    return { source_snapshot: '', proposed_text: '' };
  }
  try {
    const tip = await store.readProposalTip(doc, row.id);
    if (tip === null) return { source_snapshot: '', proposed_text: '' };
    const base = await store.readAt(doc, row.base_oid);
    const start = row.base_block_start;
    const end = row.base_block_end;
    const proposedLen = tip.length - base.length + (end - start);
    return {
      source_snapshot: base.slice(start, end),
      proposed_text: tip.slice(start, start + proposedLen),
    };
  } catch {
    return { source_snapshot: '', proposed_text: '' };
  }
}
