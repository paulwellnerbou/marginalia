import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { CommentRow, DocumentRow } from '../db.js';
import {
  authorize,
  parseCookie,
  SESSION_COOKIE,
  type Identity,
} from '../auth.js';
import type { AppDeps } from './documents.js';

export function commentsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.get('/:uid/comments', async (c) => listComments(c, deps));
  r.post('/:uid/comments', async (c) => createComment(c, deps));
  r.put('/:uid/comments/:cid', async (c) => editComment(c, deps));
  r.delete('/:uid/comments/:cid', async (c) => deleteComment(c, deps));
  r.post('/:uid/comments/:cid/resolve', async (c) => resolveComment(c, deps));

  return r;
}

// --- list ------------------------------------------------------------

async function listComments(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const rows = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
    )
    .all(doc.uid) as CommentRow[];

  return c.json({ comments: rows.map(toWire) });
}

// --- create ----------------------------------------------------------

async function createComment(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity: Identity = decision.identity;

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const text = asString(body.body);
  if (!text || text.length > 5000) {
    return c.json({ error: 'body-required' }, 400);
  }

  const parentId = asString(body.parent_id);

  if (parentId) {
    const parent = db
      .prepare('SELECT * FROM comments WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
      .get(parentId, doc.uid) as CommentRow | undefined;
    if (!parent) return c.json({ error: 'parent-not-found' }, 400);
    if (parent.parent_id !== null) return c.json({ error: 'nested-replies' }, 400);
  }

  const id = newCommentId();
  const now = Date.now();

  if (parentId) {
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id, author_client_id, author_display_name,
          body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, doc.uid, parentId, identity.clientId, identity.displayName, text, now, now);
  } else {
    const anchor = asAnchor(body.anchor);
    if (!anchor) return c.json({ error: 'anchor-required' }, 400);
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id,
          anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
          anchor_start_offset, anchor_end_offset,
          author_client_id, author_display_name,
          body, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      doc.uid,
      anchor.blockId,
      anchor.quote,
      anchor.prefix,
      anchor.suffix,
      anchor.startOffset,
      anchor.endOffset,
      identity.clientId,
      identity.displayName,
      text,
      now,
      now,
    );
  }

  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow;
  const wire = toWire(row);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'comment.created', comment: wire },
    identity.clientId,
  );
  return c.json({ comment: wire }, 201);
}

// --- edit ------------------------------------------------------------

async function editComment(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const row = db
    .prepare('SELECT * FROM comments WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(cid, doc.uid) as CommentRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.author_client_id !== identity.clientId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  const text = body ? asString(body.body) : null;
  if (!text || text.length > 5000) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(text, now, cid);

  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(cid) as CommentRow;
  const wire = toWire(updated);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'comment.updated', comment: wire },
    identity.clientId,
  );
  return c.json({ comment: wire });
}

// --- delete ----------------------------------------------------------

async function deleteComment(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const row = db
    .prepare('SELECT * FROM comments WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(cid, doc.uid) as CommentRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);

  const isAuthor = row.author_client_id === identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);

  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), cid);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'comment.deleted', comment_id: cid },
    identity.clientId,
  );
  return c.body(null, 204);
}

// --- resolve / unresolve --------------------------------------------

async function resolveComment(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const row = db
    .prepare('SELECT * FROM comments WHERE id = ? AND doc_uid = ? AND deleted_at IS NULL')
    .get(cid, doc.uid) as CommentRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.parent_id !== null) {
    return c.json({ error: 'replies-not-resolvable' }, 400);
  }

  const body = await safeJson(c);
  const resolved = body?.resolved === true;
  const now = Date.now();
  db.prepare(
    `UPDATE comments
        SET resolved_at = ?, resolved_by_name = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    resolved ? now : null,
    resolved ? identity.displayName : null,
    now,
    cid,
  );

  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(cid) as CommentRow;
  const wire = toWire(updated);
  deps.realtime.broadcast(
    doc.uid,
    { type: 'comment.updated', comment: wire },
    identity.clientId,
  );
  return c.json({ comment: wire });
}

// --- helpers ---------------------------------------------------------

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

function asAnchor(v: unknown): {
  blockId: string;
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
} | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  const blockId = asString(a.block_id);
  const quote = typeof a.quote === 'string' ? a.quote : null;
  if (!blockId || quote === null) return null;
  return {
    blockId,
    quote,
    prefix: typeof a.prefix === 'string' ? a.prefix : '',
    suffix: typeof a.suffix === 'string' ? a.suffix : '',
    startOffset: typeof a.start_offset === 'number' ? a.start_offset : 0,
    endOffset: typeof a.end_offset === 'number' ? a.end_offset : quote.length,
  };
}

function newCommentId(): string {
  return randomBytes(12).toString('base64url');
}

export function toWire(row: CommentRow): Record<string, unknown> {
  return {
    id: row.id,
    parent_id: row.parent_id,
    anchor: row.parent_id
      ? null
      : {
          block_id: row.anchor_block_id,
          quote: row.anchor_quote,
          prefix: row.anchor_prefix,
          suffix: row.anchor_suffix,
          start_offset: row.anchor_start_offset,
          end_offset: row.anchor_end_offset,
        },
    author: { client_id: row.author_client_id, display_name: row.author_display_name },
    body: row.body,
    status: row.status,
    resolved_at: row.resolved_at,
    resolved_by_name: row.resolved_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
