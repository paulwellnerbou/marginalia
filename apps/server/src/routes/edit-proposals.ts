import type { Database } from 'bun:sqlite';
import type { BlockSourceRange } from '@marginalia/renderer';
import { canMergeMultiBlock, locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import type { DocumentRow, EditProposalThreadRow } from '../db.js';
import type { GitStore } from '../git-store.js';
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
    cep.is_whole_document,
    cep.answers_comment_id,
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
  blocks: Map<string, BlockSourceRange>,
  format: 'markdown' | 'asciidoc',
  now: number,
  broadcast?: (row: EditProposalThreadRow) => void,
): EditProposalThreadRow[] {
  const open = db
    .prepare(
      `${PROPOSAL_SELECT}
       WHERE c.doc_uid = ? AND cep.status = 'open' AND c.deleted_at IS NULL`,
    )
    .all(docUid) as EditProposalThreadRow[];
  const markComment = db.prepare(
    `UPDATE comments
        SET link_status = 'orphaned', anchor_block_id = NULL, anchor_end_block_id = NULL,
            updated_at = ?
      WHERE id = ?`,
  );
  const orphaned: EditProposalThreadRow[] = [];
  for (const p of open) {
    // Whole-document proposals replace the entire source — there's no
    // anchor block whose disappearance should orphan them.
    if (p.is_whole_document === 1) continue;
    const startBlock = p.anchor_block_id ? blocks.get(p.anchor_block_id) : undefined;
    const startMissing = !p.anchor_block_id || !startBlock;
    let endMissing = false;
    let structurallyInvalid = false;
    if (!startMissing && p.anchor_end_block_id != null) {
      const endBlock = blocks.get(p.anchor_end_block_id);
      if (!endBlock) {
        endMissing = true;
      } else if (!canMergeMultiBlock(startBlock!, endBlock, format)) {
        // Both endpoint IDs still resolve, but the multi-block span
        // is no longer structurally safe (e.g. an upstream edit moved
        // one item into a different list depth, or what was a
        // top-level list is now nested/quoted). Orphan so the
        // proposal doesn't sit "linked" until someone tries to
        // diff or accept it.
        structurallyInvalid = true;
      }
    }
    if (startMissing || endMissing || structurallyInvalid) {
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

/**
 * Resolve a proposal anchor (single-block or multi-block) to a source
 * range in the given document source. Centralizes the format dispatch
 * and the multi-block endpoint validation so accept, diff, and orphan
 * paths can't drift apart.
 *
 * Validation goes through the renderer's `canMergeMultiBlock`:
 *   - `tableCell` endpoints are always rejected (would slice across
 *     `|` pipes).
 *   - `listItem` endpoints are accepted only when both endpoints are
 *     `listItem` AND share the same `parentStart` (same parent list,
 *     same nesting depth). The asciidoc walker doesn't populate
 *     `parentStart` for items, so asciidoc multi-listItem is rejected
 *     here too — this also covers the best-effort
 *     `listItemSourceRange` (no continuation support).
 *   - Cross-depth or cross-list listItem spans, or `listItem` paired
 *     with a different kind, are rejected to avoid splicing across
 *     structural boundaries.
 *
 * The merged range is computed directly from the per-block map we
 * already built — no second parse via `locateBlockRange*`.
 */
export function locateAnchorRange(
  doc: DocumentRow,
  source: string,
  blockId: string,
  endBlockId: string | null,
): BlockSourceRange | null {
  const blocks = locateDocumentBlocks(doc, source);
  const startBlock = blocks.get(blockId);
  if (!startBlock) return null;
  if (!endBlockId || endBlockId === blockId) return startBlock;
  const endBlock = blocks.get(endBlockId);
  if (!endBlock) return null;
  if (!canMergeMultiBlock(startBlock, endBlock, doc.format)) return null;
  return {
    start: Math.min(startBlock.start, endBlock.start),
    end: Math.max(startBlock.end, endBlock.end),
    kind: 'multi',
    text: '',
  };
}

export function locateDocumentBlocks(
  doc: DocumentRow,
  source: string,
): Map<string, BlockSourceRange> {
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
  let overlap: { id: string; range: BlockSourceRange; amount: number; span: number } | null = null;

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
      if (
        !overlap ||
        amount > overlap.amount ||
        (amount === overlap.amount && span < overlap.span)
      ) {
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
    status: row.proposal_status,
    decided_at: row.decided_at,
    decided_by_name: row.decided_by_name,
    whole_document: row.is_whole_document === 1,
    answers_thread_id: row.answers_comment_id,
  };
}

/**
 * Recover the legacy `source_snapshot` + `proposed_text` fields from
 * the proposal's branch tip and base blob. Returns `null` when the
 * row lacks the metadata to address the splice range or git is
 * unreachable — the caller surfaces null fields so clients can
 * distinguish "diff unavailable" from a legitimate empty proposal.
 * Phase 4 will drop these from the wire entirely.
 *
 * `base_block_{start,end}` are character offsets into the decoded
 * source string (matching unist `position.offset`), not raw byte
 * offsets — `String.prototype.slice` is the right operator, not a
 * `Buffer` slice.
 *
 * Takes the minimal structural shape so callers with different row
 * types (thread, bundle export, history) can use the same recovery
 * helper without casts.
 */
export async function readProposalContent(
  store: GitStore,
  doc: DocumentRow,
  row: {
    id: string;
    branch_ref: string | null;
    base_oid: string | null;
    base_block_start: number | null;
    base_block_end: number | null;
  },
): Promise<{ source_snapshot: string; proposed_text: string } | null> {
  if (
    !row.branch_ref ||
    !row.base_oid ||
    row.base_block_start === null ||
    row.base_block_end === null
  ) {
    return null;
  }
  // GitStore derives the ref name from the proposal id internally
  // (`refs/proposals/<id>`). Refuse to read if the row's stored
  // `branch_ref` doesn't match — guards against silently reading a
  // different ref if the persisted shape ever drifts (e.g. future
  // synthesized historical refs).
  if (row.branch_ref !== `refs/proposals/${row.id}`) return null;
  try {
    const tip = await store.readProposalTip(doc, row.id);
    if (tip === null) return null;
    const base = await store.readAt(doc, row.base_oid);
    const start = row.base_block_start;
    const end = row.base_block_end;
    const proposedLen = tip.length - base.length + (end - start);
    return {
      source_snapshot: base.slice(start, end),
      proposed_text: tip.slice(start, start + proposedLen),
    };
  } catch {
    return null;
  }
}

export async function readProposalFullContent(
  store: GitStore,
  doc: DocumentRow,
  row: {
    id: string;
    branch_ref: string | null;
    base_oid: string | null;
  },
): Promise<{ before: string; after: string } | null> {
  if (!row.branch_ref || !row.base_oid) return null;
  if (row.branch_ref !== `refs/proposals/${row.id}`) return null;
  try {
    const after = await store.readProposalTip(doc, row.id);
    if (after === null) return null;
    const before = await store.readAt(doc, row.base_oid);
    return { before, after };
  } catch {
    return null;
  }
}
