import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
  renderDocument,
} from '@marginalia/renderer';
import type { BlockInfo, BlockSourceRange } from '@marginalia/renderer';
import type { CommentRow, DocumentRow, EditProposalThreadRow } from '../db.js';
import { reanchor } from '../anchoring.js';
import {
  authorize,
  canEdit,
  canPropose,
  parseCookie,
  SESSION_COOKIE,
  type Identity,
} from '../auth.js';
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
    c.resolved_at AS decided_at,
    c.resolved_by_name AS decided_by_name
  FROM comments c
  INNER JOIN comments_edit_proposals cep ON cep.comment_id = c.id
`;

// --- list ------------------------------------------------------------

/** Lists proposal roots with their embedded root-comment data. */
async function listProposals(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const rows = db
    .prepare(
      `${PROPOSAL_SELECT}
       WHERE c.doc_uid = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
    )
    .all(doc.uid) as EditProposalThreadRow[];

  return c.json({ edit_proposals: rows.map(toWire) });
}

// --- create ----------------------------------------------------------

/** Creates a proposal root plus its proposal-extension row. */
async function createProposal(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);
  const identity: Identity = decision.identity;

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const blockId = asString(body.anchor_block_id);
  const quote = typeof body.anchor_quote === 'string' ? body.anchor_quote : null;
  const kind = typeof body.anchor_kind === 'string' ? body.anchor_kind : null;
  const proposed = typeof body.proposed_text === 'string' ? body.proposed_text : null;
  const rationale =
    typeof body.rationale === 'string' && body.rationale.trim().length > 0
      ? body.rationale.trim().slice(0, 2000)
      : null;

  if (!blockId || quote === null) return c.json({ error: 'anchor-required' }, 400);
  if (proposed === null || proposed.length === 0) {
    return c.json({ error: 'proposed-text-required' }, 400);
  }
  if (proposed.length > 20000) return c.json({ error: 'proposed-text-too-long' }, 400);

  const currentSource = store.read(doc.path);
  const sourceSnapshot = readProposalBlockSource(doc, currentSource, blockId) ?? quote;
  const id = newProposalId();
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id, parent_proposal_id,
          anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
          anchor_start_offset, anchor_end_offset,
          anchor_heading_path, anchor_section_index, anchor_section_index_path,
          author_client_id, author_display_name,
          body, link_status, resolved_at, resolved_by_name,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 'linked', NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      doc.uid,
      blockId,
      quote,
      identity.clientId,
      identity.displayName,
      rationale ?? '',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO comments_edit_proposals
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid)
       VALUES (?, ?, ?, ?, 'open', NULL)`,
    ).run(id, kind, sourceSnapshot, proposed);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const row = loadProposalRow(db, id, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);
  const wire = toWire(row);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.created', edit_proposal: wire },
    identity.clientId,
  );
  return c.json({ edit_proposal: wire }, 201);
}

// --- diff ------------------------------------------------------------

/** Returns the before/after text for a proposal. */
async function getProposalDiff(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const pid = c.req.param('pid');
  if (!pid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, pid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);

  const before = await resolveProposalDiffBefore(doc, row, deps);
  return c.json({ before, after: row.proposed_text });
}

// --- delete ----------------------------------------------------------

// --- edit (rationale only) ------------------------------------------

/** Edits only the root comment body used as proposal rationale. */
async function editProposal(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const pid = c.req.param('pid');
  if (!pid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, pid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.author_client_id !== decision.identity.clientId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  // Only the rationale is editable — the proposed_text defines a concrete
  // patch and shouldn't silently change after reviewers have seen it.
  const rawRationale = body.rationale;
  const rationale =
    rawRationale === null
      ? null
      : typeof rawRationale === 'string'
        ? rawRationale.trim().slice(0, 2000) || null
        : undefined;
  if (rationale === undefined) return c.json({ error: 'rationale-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(rationale, now, pid);
  const updated = loadProposalRow(db, pid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const wire = toWire(updated);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.updated', edit_proposal: wire },
    decision.identity.clientId,
  );
  return c.json({ edit_proposal: wire });
}

// --- delete ----------------------------------------------------------

/** Soft-deletes a proposal root. Accepted proposals are admin-delete only. */
async function deleteProposal(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const pid = c.req.param('pid');
  if (!pid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, pid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);

  const isAuthor = row.author_client_id === decision.identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);
  // Accepted proposals are part of the audit trail — only admins may remove
  // them. Authors can delete their own open/rejected proposals.
  if (row.proposal_status === 'accepted' && !isAdmin) {
    return c.json({ error: 'forbidden-accepted' }, 403);
  }

  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), pid);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.deleted', edit_proposal_id: pid },
    decision.identity.clientId,
  );
  return c.body(null, 204);
}

// --- reject ----------------------------------------------------------

/** Rejects an open proposal without mutating document content. */
async function rejectProposal(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const pid = c.req.param('pid');
  if (!pid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, pid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);

  const now = Date.now();
  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'rejected'
      WHERE comment_id = ?`,
  ).run(pid);
  db.prepare(
    `UPDATE comments
        SET resolved_at = ?, resolved_by_name = ?, updated_at = ?
      WHERE id = ?`,
  ).run(now, decision.identity.displayName, now, pid);

  const updated = loadProposalRow(db, pid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const wire = toWire(updated);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.updated', edit_proposal: wire },
    decision.identity.clientId,
  );
  return c.json({ edit_proposal: wire });
}

// --- accept ----------------------------------------------------------

/** Applies an open proposal to the document and records the accepted commit. */
async function acceptProposal(c: Context, deps: AppDeps) {
  const { db, store, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);
  const identity = decision.identity;

  const pid = c.req.param('pid');
  if (!pid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, pid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);
  if (!row.anchor_block_id) return c.json({ error: 'proposal-orphaned' }, 409);

  const source = store.read(doc.path);
  const range =
    doc.format === 'asciidoc'
      ? (locateAllBlocksAsciidoc(source).get(row.anchor_block_id) ?? null)
      : locateBlockSource(source, row.anchor_block_id);
  if (!range) {
    // Block no longer present — mark the root comment orphaned so the UI
    // reflects reality, but keep the proposal open so it can still be
    // rejected.
    const now = Date.now();
    db.prepare(
      `UPDATE comments
          SET link_status = 'orphaned', anchor_block_id = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(now, pid);
    const updated = loadProposalRow(db, pid, doc.uid);
    if (!updated) return c.json({ error: 'not-found' }, 404);
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.updated', edit_proposal: toWire(updated) },
      identity.clientId,
    );
    return c.json({ error: 'block-not-found' }, 409);
  }

  const nextSource = source.slice(0, range.start) + row.proposed_text + source.slice(range.end);

  const { oid } = await store.write(doc.uid, doc.format, nextSource, identity, 'accept-proposal', {
    proposalId: pid,
  });
  const now = Date.now();
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

  // Re-anchor comments against the new document.
  const rendered = await renderDocument(nextSource, doc.format);
  const presentBlocks = locateDocumentBlocks(doc, nextSource);
  const topLevelComments = db
    .prepare(
      `SELECT c.*
         FROM comments c
         LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
        WHERE c.doc_uid = ?
          AND c.parent_id IS NULL
          AND c.parent_proposal_id IS NULL
          AND c.deleted_at IS NULL
          AND cep.comment_id IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const updateCommentStmt = db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevelComments) {
    const upd = reanchor(comment, rendered.blocks);
    updateCommentStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  const acceptedAnchor = locateAcceptedProposalAnchor(
    presentBlocks,
    rendered.blocks,
    range.start,
    range.start + row.proposed_text.length,
  );

  // Mark this proposal accepted and move its root comment onto the new block
  // so the thread stays attached after the block hash changes.
  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'accepted', accepted_oid = ?
      WHERE comment_id = ?`,
  ).run(oid, pid);
  db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?,
            anchor_start_offset = ?,
            anchor_end_offset = ?,
            anchor_heading_path = ?,
            anchor_section_index = ?,
            anchor_section_index_path = ?,
            link_status = ?,
            resolved_at = ?,
            resolved_by_name = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    acceptedAnchor?.block.id ?? row.anchor_block_id,
    null,
    null,
    acceptedAnchor ? JSON.stringify(acceptedAnchor.block.headingPath) : row.anchor_heading_path,
    acceptedAnchor?.block.sectionIndex ?? row.anchor_section_index,
    acceptedAnchor ? JSON.stringify(acceptedAnchor.block.sectionIndexPath) : row.anchor_section_index_path,
    acceptedAnchor?.linkStatus ?? row.link_status,
    now,
    identity.displayName,
    now,
    pid,
  );

  // Re-anchor other open proposals (their block hash may have shifted).
  // Include sub-block ids (list items / table cells) so fine-grained
  // proposals don't get orphaned on every save.
  reanchorProposals(db, doc.uid, [...presentBlocks.keys()], now, realtime, identity.clientId);

  const accepted = loadProposalRow(db, pid, doc.uid);
  if (!accepted) return c.json({ error: 'not-found' }, 404);
  const wire = toWire(accepted);

  realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.updated', edit_proposal: wire },
    identity.clientId,
  );
  realtime.broadcast(
    doc.uid,
    { type: 'document.updated', oid, author: identity.displayName },
    identity.clientId,
  );

  return c.json({ edit_proposal: wire, oid });
}

// --- helpers ---------------------------------------------------------

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

function loadDoc(db: Database, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}

function authorizeRequest(c: Context, deps: AppDeps, doc: DocumentRow) {
  const sessionToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
  return authorize(deps.db, doc, c.req.raw.headers, sessionToken);
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function newProposalId(): string {
  return randomBytes(12).toString('base64url');
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
    const liveSource = deps.store.read(doc.path);
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

  const history = await deps.store.history(doc.path);
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
  const diff = await deps.store.diffAt(doc.path, acceptedOid);
  if (!diff) return null;
  const before = readProposalBlockSource(doc, diff.before, proposal.anchor_block_id);
  if (before) {
    if (!diff.after.includes(proposal.proposed_text)) return null;
    return before;
  }
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

function locateDocumentBlocks(doc: DocumentRow, source: string): Map<string, BlockSourceRange> {
  return doc.format === 'asciidoc' ? locateAllBlocksAsciidoc(source) : locateAllBlocks(source);
}

function findBlockBySourceSpan(
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

function locateAcceptedProposalAnchor(
  blocks: Map<string, BlockSourceRange>,
  renderedBlocks: BlockInfo[],
  start: number,
  end: number,
): { block: BlockInfo; linkStatus: 'linked' | 'low-confidence' } | null {
  const located = findBlockBySourceSpan(blocks, start, end);
  if (!located) return null;
  const rendered = renderedBlocks.find((block) => block.id === located.id);
  if (!rendered) return null;
  return { block: rendered, linkStatus: located.confidence };
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
