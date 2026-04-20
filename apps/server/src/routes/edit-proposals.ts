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
  r.post('/:uid/edit-proposals', async (c) => createProposal(c, deps));
  r.patch('/:uid/edit-proposals/:pid', async (c) => editProposal(c, deps));
  r.delete('/:uid/edit-proposals/:pid', async (c) => deleteProposal(c, deps));
  r.post('/:uid/edit-proposals/:pid/accept', async (c) => acceptProposal(c, deps));
  r.post('/:uid/edit-proposals/:pid/reject', async (c) => rejectProposal(c, deps));

  return r;
}

// --- list ------------------------------------------------------------

async function listProposals(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const rows = db
    .prepare(
      `SELECT * FROM edit_proposals
         WHERE doc_uid = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
    )
    .all(doc.uid) as EditProposalRow[];

  return c.json({ edit_proposals: rows.map(toWire) });
}

// --- create ----------------------------------------------------------

async function createProposal(c: Context, deps: AppDeps) {
  const { db } = deps;
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
  const rationale = typeof body.rationale === 'string' && body.rationale.trim().length > 0
    ? body.rationale.trim().slice(0, 2000)
    : null;

  if (!blockId || quote === null) return c.json({ error: 'anchor-required' }, 400);
  if (proposed === null || proposed.length === 0) {
    return c.json({ error: 'proposed-text-required' }, 400);
  }
  if (proposed.length > 20000) return c.json({ error: 'proposed-text-too-long' }, 400);

  const id = newProposalId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO edit_proposals
       (id, doc_uid, anchor_block_id, anchor_quote, anchor_kind, proposed_text,
        rationale, author_client_id, author_display_name,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id, doc.uid, blockId, quote, kind, proposed, rationale,
    identity.clientId, identity.displayName, now, now,
  );

  const row = db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(id) as EditProposalRow;
  const wire = toWire(row);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.created', edit_proposal: wire },
    identity.clientId,
  );
  return c.json({ edit_proposal: wire }, 201);
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
  const row = db
    .prepare('SELECT * FROM edit_proposals WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(pid, doc.uid) as EditProposalRow | undefined;
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
  db.prepare('UPDATE edit_proposals SET rationale = ?, updated_at = ? WHERE id = ?').run(
    rationale,
    now,
    pid,
  );
  const updated = db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(pid) as EditProposalRow;
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
  const row = db
    .prepare('SELECT * FROM edit_proposals WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(pid, doc.uid) as EditProposalRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);

  const isAuthor = row.author_client_id === decision.identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);
  // Accepted proposals are part of the audit trail — only admins may remove
  // them. Authors can delete their own pending/rejected/orphaned proposals.
  if (row.status === 'accepted' && !isAdmin) {
    return c.json({ error: 'forbidden-accepted' }, 403);
  }

  db.prepare('UPDATE edit_proposals SET deleted_at = ? WHERE id = ?').run(Date.now(), pid);
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
  const row = db
    .prepare('SELECT * FROM edit_proposals WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(pid, doc.uid) as EditProposalRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.status !== 'pending') return c.json({ error: 'not-pending' }, 400);

  const now = Date.now();
  db.prepare(
    `UPDATE edit_proposals
        SET status = 'rejected', decided_at = ?, decided_by_name = ?, updated_at = ?
      WHERE id = ?`,
  ).run(now, decision.identity.displayName, now, pid);

  const updated = db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(pid) as EditProposalRow;
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
  const row = db
    .prepare('SELECT * FROM edit_proposals WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(pid, doc.uid) as EditProposalRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.status !== 'pending') return c.json({ error: 'not-pending' }, 400);
  if (!row.anchor_block_id) return c.json({ error: 'proposal-orphaned' }, 409);

  const source = store.read(doc.path);
  const range =
    doc.format === 'asciidoc'
      ? locateAllBlocksAsciidoc(source).get(row.anchor_block_id) ?? null
      : locateBlockSource(source, row.anchor_block_id);
  if (!range) {
    // Block no longer present — mark orphaned so the UI reflects reality.
    const now = Date.now();
    db.prepare(
      `UPDATE edit_proposals SET status = 'orphaned', updated_at = ? WHERE id = ?`,
    ).run(now, pid);
    const updated = db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(pid) as EditProposalRow;
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.updated', edit_proposal: toWire(updated) },
      identity.clientId,
    );
    return c.json({ error: 'block-not-found' }, 409);
  }

  const nextSource =
    source.slice(0, range.start) + row.proposed_text + source.slice(range.end);

  const { oid } = await store.write(doc.uid, doc.format, nextSource, identity, 'accept-proposal');
  const now = Date.now();
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

  // Re-anchor comments against the new document.
  const rendered = await renderDocument(nextSource, doc.format);
  const topLevelComments = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
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
    updateCommentStmt.run(
      upd.blockId, upd.startOffset, upd.endOffset, upd.status, now, comment.id,
    );
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
    `UPDATE edit_proposals
        SET status = 'accepted', decided_at = ?, decided_by_name = ?, updated_at = ?
      WHERE id = ?`,
  ).run(now, identity.displayName, now, pid);

  const accepted = db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(pid) as EditProposalRow;
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
      `SELECT * FROM edit_proposals
         WHERE doc_uid = ? AND status = 'pending' AND deleted_at IS NULL`,
    )
    .all(docUid) as EditProposalRow[];
  const mark = db.prepare(
    `UPDATE edit_proposals
        SET status = 'orphaned', anchor_block_id = NULL, updated_at = ?
      WHERE id = ?`,
  );
  const fetch = db.prepare('SELECT * FROM edit_proposals WHERE id = ?');
  const orphaned: EditProposalRow[] = [];
  for (const p of pending) {
    if (!p.anchor_block_id || !present.has(p.anchor_block_id)) {
      mark.run(now, p.id);
      const fresh = fetch.get(p.id) as EditProposalRow | undefined;
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

export function toWire(row: EditProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    anchor: {
      block_id: row.anchor_block_id,
      quote: row.anchor_quote,
      kind: row.anchor_kind,
    },
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
