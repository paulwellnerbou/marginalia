import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
  renderDocument,
} from '@marginalia/renderer';
import type { CommentRow, DocumentRow, EditProposalRow } from '../db.js';
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

export function editProposalsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.get('/:uid/edit-proposals', async (c) => listProposals(c, deps));
  r.get('/:uid/edit-proposals/:pid/diff', async (c) => getProposalDiff(c, deps));
  r.post('/:uid/edit-proposals', async (c) => createProposal(c, deps));
  r.patch('/:uid/edit-proposals/:pid', async (c) => editProposal(c, deps));
  r.delete('/:uid/edit-proposals/:pid', async (c) => deleteProposal(c, deps));
  r.post('/:uid/edit-proposals/:pid/accept', async (c) => acceptProposal(c, deps));
  r.post('/:uid/edit-proposals/:pid/reject', async (c) => rejectProposal(c, deps));

  return r;
}

const PROPOSAL_SELECT = `
  SELECT
    c.id,
    c.doc_uid,
    c.anchor_block_id,
    c.anchor_quote,
    cep.anchor_kind,
    cep.source_snapshot,
    cep.proposed_text,
    NULLIF(c.body, '') AS rationale,
    c.author_client_id,
    c.author_display_name,
    cep.status,
    cep.accepted_oid,
    cep.decided_at,
    cep.decided_by_name,
    c.created_at,
    c.updated_at,
    c.deleted_at
  FROM comments c
  INNER JOIN comments_edit_proposals cep ON cep.comment_id = c.id
`;

// --- list ------------------------------------------------------------

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
    .all(doc.uid) as EditProposalRow[];

  return c.json({ edit_proposals: rows.map(toWire) });
}

// --- create ----------------------------------------------------------

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
          body, status, resolved_at, resolved_by_name,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
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
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid, decided_at, decided_by_name)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
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
  // them. Authors can delete their own pending/rejected/orphaned proposals.
  if (row.status === 'accepted' && !isAdmin) {
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
  if (row.status !== 'pending') return c.json({ error: 'not-pending' }, 400);

  const now = Date.now();
  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'rejected', decided_at = ?, decided_by_name = ?
      WHERE comment_id = ?`,
  ).run(now, decision.identity.displayName, pid);
  db.prepare('UPDATE comments SET updated_at = ? WHERE id = ?').run(now, pid);

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
  if (row.status !== 'pending') return c.json({ error: 'not-pending' }, 400);
  if (!row.anchor_block_id) return c.json({ error: 'proposal-orphaned' }, 409);

  const source = store.read(doc.path);
  const range =
    doc.format === 'asciidoc'
      ? (locateAllBlocksAsciidoc(source).get(row.anchor_block_id) ?? null)
      : locateBlockSource(source, row.anchor_block_id);
  if (!range) {
    // Block no longer present — mark orphaned so the UI reflects reality.
    const now = Date.now();
    db.prepare(`UPDATE comments_edit_proposals SET status = 'orphaned' WHERE comment_id = ?`).run(
      pid,
    );
    db.prepare(
      `UPDATE comments
          SET status = 'orphaned', anchor_block_id = NULL, updated_at = ?
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
            status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevelComments) {
    const upd = reanchor(comment, rendered.blocks);
    updateCommentStmt.run(upd.blockId, upd.startOffset, upd.endOffset, upd.status, now, comment.id);
  }

  // Re-anchor other pending proposals (their block hash may have shifted).
  // Include sub-block ids (list items / table cells) so fine-grained
  // proposals don't get orphaned on every save.
  const knownIds =
    doc.format === 'asciidoc'
      ? [...locateAllBlocksAsciidoc(nextSource).keys()]
      : [...locateAllBlocks(nextSource).keys()];
  reanchorProposals(db, doc.uid, knownIds, now, realtime, identity.clientId);

  // Mark this proposal accepted.
  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'accepted', accepted_oid = ?, decided_at = ?, decided_by_name = ?
      WHERE comment_id = ?`,
  ).run(oid, now, identity.displayName, pid);
  db.prepare('UPDATE comments SET updated_at = ? WHERE id = ?').run(now, pid);

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
 * Mark any pending proposal whose anchor block is no longer present as
 * orphaned, null out its `anchor_block_id` so clients stop offering
 * jump-to-anchor against a stale id, and broadcast `edit_proposal.updated`
 * for each one so UIs update live. Used after any source edit (proposal
 * acceptance or direct save).
 *
 * Returns the orphaned proposal rows (post-update) for callers that need
 * to do more with them.
 */
export function reanchorProposals(
  db: Database,
  docUid: string,
  presentBlockIds: string[],
  now: number,
  realtime?: Realtime,
  exceptClientId?: string,
): EditProposalRow[] {
  const present = new Set(presentBlockIds);
  const pending = db
    .prepare(
      `${PROPOSAL_SELECT}
       WHERE c.doc_uid = ? AND cep.status = 'pending' AND c.deleted_at IS NULL`,
    )
    .all(docUid) as EditProposalRow[];
  const markProposal = db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'orphaned'
      WHERE comment_id = ?`,
  );
  const markComment = db.prepare(
    `UPDATE comments
        SET status = 'orphaned', anchor_block_id = NULL, updated_at = ?
      WHERE id = ?`,
  );
  const orphaned: EditProposalRow[] = [];
  for (const p of pending) {
    if (!p.anchor_block_id || !present.has(p.anchor_block_id)) {
      markProposal.run(p.id);
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
): EditProposalRow | undefined {
  return db
    .prepare(
      `${PROPOSAL_SELECT}
      WHERE c.id = ? AND c.doc_uid = ? AND c.deleted_at IS NULL`,
    )
    .get(proposalId, docUid) as EditProposalRow | undefined;
}

export function reopenAcceptedProposal(
  db: Database,
  docUid: string,
  proposalId: string,
  now: number,
): EditProposalRow | null {
  const row = loadProposalRow(db, proposalId, docUid);
  if (!row) return null;
  if (row.status !== 'accepted') return null;

  db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'pending', accepted_oid = NULL, decided_at = NULL, decided_by_name = NULL
      WHERE comment_id = ?`,
  ).run(proposalId);
  db.prepare('UPDATE comments SET updated_at = ? WHERE id = ?').run(now, proposalId);

  return loadProposalRow(db, proposalId, docUid) ?? null;
}

async function resolveProposalDiffBefore(
  doc: DocumentRow,
  proposal: EditProposalRow,
  deps: AppDeps,
): Promise<string> {
  const snapshot = proposal.source_snapshot ?? proposal.anchor_quote ?? '';

  if (proposal.status !== 'accepted') {
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
  proposal: EditProposalRow,
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
  proposal: EditProposalRow,
  acceptedOid: string,
  deps: AppDeps,
): Promise<string | null> {
  const diff = await deps.store.diffAt(doc.path, acceptedOid);
  if (!diff) return null;
  const before = readProposalBlockSource(doc, diff.before, proposal.anchor_block_id);
  if (!before) return null;
  if (!diff.after.includes(proposal.proposed_text)) return null;
  return before;
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
    doc.format === 'asciidoc'
      ? (locateAllBlocksAsciidoc(source).get(blockId) ?? null)
      : locateBlockSource(source, blockId);
  return range ? source.slice(range.start, range.end) : null;
}

export function toWire(row: EditProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    anchor: {
      block_id: row.anchor_block_id,
      quote: row.anchor_quote,
      kind: row.anchor_kind,
    },
    source_snapshot: row.source_snapshot,
    proposed_text: row.proposed_text,
    rationale: row.rationale,
    author: { client_id: row.author_client_id, display_name: row.author_display_name },
    status: row.status,
    decided_at: row.decided_at,
    decided_by_name: row.decided_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
