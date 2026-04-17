import { Hono } from 'hono';
import type { Context } from 'hono';
import { render } from '@marginalia/renderer';
import type { Database } from 'bun:sqlite';
import type { GitStore } from '../git-store.js';
import type { ServerConfig } from '../config.js';
import type { CommentRow, DocumentRow, InviteRow, InviteRole } from '../db.js';
import { reanchor } from '../anchoring.js';
import type { Realtime } from '../realtime.js';
import {
  authorize,
  createSession,
  hashPassword,
  parseCookie,
  readIdentity,
  SESSION_COOKIE,
  verifyPassword,
  type Identity,
  type Role,
} from '../auth.js';
import { newDocumentUid, newInviteToken } from '../ids.js';
import { randomBytes } from 'node:crypto';

export interface AppDeps {
  db: Database;
  store: GitStore;
  config: ServerConfig;
  realtime: Realtime;
}

export function documentsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => createDocument(c, deps));
  r.get('/:uid', async (c) => getDocument(c, deps));
  r.put('/:uid', async (c) => updateDocument(c, deps));
  r.patch('/:uid/settings', async (c) => updateSettings(c, deps));
  r.get('/:uid/history', async (c) => getHistory(c, deps));
  r.post('/:uid/auth', async (c) => authenticate(c, deps));

  r.get('/:uid/invites', async (c) => listInvites(c, deps));
  r.post('/:uid/invites', async (c) => createInvite(c, deps));
  r.delete('/:uid/invites/:token', async (c) => deleteInvite(c, deps));

  return r;
}

// --- POST /api/documents ---------------------------------------------

async function createDocument(c: Context, { db, store }: AppDeps) {
  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const markdown = body.markdown;
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return c.json({ error: 'markdown-required' }, 400);
  }

  const uid = newDocumentUid();
  const now = Date.now();

  let passwordHash: string | null = null;
  let plaintextPassword: string | null = null;
  if (body.password_protected === true) {
    plaintextPassword = generatePassword();
    passwordHash = await hashPassword(plaintextPassword);
  }

  const editable = body.editable_by_anyone === true ? 1 : 0;
  const theme = typeof body.default_theme === 'string' ? body.default_theme : 'default';
  const docName =
    typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim().slice(0, 200)
      : null;

  await store.write(uid, markdown, identity, 'upload');

  db.prepare(
    `INSERT INTO documents
       (uid, path, name, password_hash, editable_by_anyone, default_theme, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uid, store.docPath(uid), docName, passwordHash, editable, theme, now, now);

  // Every doc gets an admin invite for its creator. The returned URL is the
  // admin's canonical way to come back to the doc.
  const adminInvite = createInviteRow(db, {
    docUid: uid,
    displayName: identity.displayName,
    role: 'admin',
    note: 'Author',
    createdByName: identity.displayName,
  });

  const response: Record<string, unknown> = {
    uid,
    name: docName,
    admin_invite: {
      token: adminInvite.token,
      url: `/d/${uid}/${adminInvite.token}`,
      display_name: adminInvite.display_name,
    },
    default_theme: theme,
    editable_by_anyone: editable === 1,
  };
  if (plaintextPassword) response.password = plaintextPassword;
  return c.json(response, 201);
}

// --- GET /api/documents/:uid -----------------------------------------

async function getDocument(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const source = store.read(doc.uid);
  const rendered = await render(source);

  return c.json({
    uid: doc.uid,
    name: doc.name,
    source,
    rendered,
    editable_by_anyone: doc.editable_by_anyone === 1,
    default_theme: doc.default_theme,
    password_protected: doc.password_hash !== null,
    role: decision.role,
    display_name: decision.identity?.displayName ?? null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  });
}

// --- PUT /api/documents/:uid -----------------------------------------

async function updateDocument(c: Context, deps: AppDeps) {
  const { db, store, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const body = await safeJson(c);
  if (!body || typeof body.markdown !== 'string') {
    return c.json({ error: 'markdown-required' }, 400);
  }

  let previousSource = '';
  try {
    previousSource = store.read(doc.uid);
  } catch {
    /* new doc */
  }

  const { oid } = await store.write(doc.uid, body.markdown, decision.identity, 'update');
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(Date.now(), doc.uid);

  const rendered = await render(body.markdown);
  const topLevel = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const updateStmt = db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            status = ?, updated_at = ?
      WHERE id = ?`,
  );
  const now = Date.now();
  for (const comment of topLevel) {
    const upd = reanchor(comment, rendered.blocks);
    updateStmt.run(upd.blockId, upd.startOffset, upd.endOffset, upd.status, now, comment.id);
  }

  if (isContentChange(previousSource, body.markdown)) {
    realtime.broadcast(
      doc.uid,
      { type: 'document.updated', oid, author: decision.identity.displayName },
      decision.identity.clientId,
    );
  }

  return c.json({ oid });
}

function isContentChange(before: string, after: string): boolean {
  return normalizeWhitespace(before) !== normalizeWhitespace(after);
}
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// --- PATCH /api/documents/:uid/settings (admin only) ----------------

async function updateSettings(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  type Bind = string | number | null;
  const updates: Array<[string, Bind]> = [];
  let plaintextPassword: string | null = null;

  if (typeof body.editable_by_anyone === 'boolean') {
    updates.push(['editable_by_anyone', body.editable_by_anyone ? 1 : 0]);
  }
  if (typeof body.default_theme === 'string') {
    updates.push(['default_theme', body.default_theme]);
  }
  if (body.name === null) {
    updates.push(['name', null]);
  } else if (typeof body.name === 'string') {
    updates.push(['name', body.name.trim().slice(0, 200) || null]);
  }
  if (body.password === null) {
    updates.push(['password_hash', null]);
  } else if (body.password === 'rotate') {
    plaintextPassword = generatePassword();
    updates.push(['password_hash', await hashPassword(plaintextPassword)]);
    db.prepare('DELETE FROM sessions WHERE doc_uid = ?').run(doc.uid);
  }

  if (updates.length === 0) return c.json({ error: 'no-updates' }, 400);

  const set = updates.map(([k]) => `${k} = ?`).join(', ');
  const vals: Bind[] = updates.map(([, v]) => v);
  db.prepare(`UPDATE documents SET ${set}, updated_at = ? WHERE uid = ?`).run(
    ...vals,
    Date.now(),
    doc.uid,
  );

  const fresh = loadDoc(db, doc.uid)!;
  const response: Record<string, unknown> = {
    name: fresh.name,
    editable_by_anyone: fresh.editable_by_anyone === 1,
    default_theme: fresh.default_theme,
    password_protected: fresh.password_hash !== null,
  };
  if (plaintextPassword) response.password = plaintextPassword;
  return c.json(response);
}

// --- GET /api/documents/:uid/history ---------------------------------

async function getHistory(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const history = await store.history(doc.uid);
  return c.json({ history });
}

// --- POST /api/documents/:uid/auth -----------------------------------

async function authenticate(c: Context, deps: AppDeps) {
  const { db, config } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);
  if (doc.password_hash === null) {
    return c.json({ error: 'not-password-protected' }, 400);
  }

  const body = await safeJson(c);
  if (!body || typeof body.password !== 'string') {
    return c.json({ error: 'password-required' }, 400);
  }

  const ok = await verifyPassword(body.password, doc.password_hash);
  if (!ok) return c.json({ error: 'wrong-password' }, 401);

  const token = createSession(db, doc.uid, config.sessionTtlMs);
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
  return c.body(null, 204);
}

// --- Invites (admin only) --------------------------------------------

async function listInvites(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const rows = db
    .prepare('SELECT * FROM invites WHERE doc_uid = ? ORDER BY created_at ASC')
    .all(doc.uid) as InviteRow[];
  return c.json({ invites: rows.map(toInviteWire) });
}

async function createInvite(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const displayName = asString(body.display_name);
  const role = asRole(body.role);
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  if (!displayName || !role) {
    return c.json({ error: 'display_name-and-role-required' }, 400);
  }

  const row = createInviteRow(db, {
    docUid: doc.uid,
    displayName,
    role,
    note,
    createdByName: decision.identity.displayName,
  });
  return c.json({ invite: toInviteWire(row) }, 201);
}

async function deleteInvite(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const token = c.req.param('token');
  if (!token) return c.json({ error: 'not-found' }, 404);

  // Revoking the last admin invite would lock the doc out of admin
  // control — refuse.
  const row = db
    .prepare('SELECT * FROM invites WHERE token = ? AND doc_uid = ?')
    .get(token, doc.uid) as InviteRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.role === 'admin') {
    const otherAdmins = db
      .prepare('SELECT COUNT(*) as n FROM invites WHERE doc_uid = ? AND role = ? AND token != ?')
      .get(doc.uid, 'admin', token) as { n: number };
    if (otherAdmins.n === 0) {
      return c.json({ error: 'last-admin-invite' }, 400);
    }
  }

  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
  return c.body(null, 204);
}

function createInviteRow(
  db: Database,
  opts: {
    docUid: string;
    displayName: string;
    role: InviteRole;
    note: string | null;
    createdByName: string;
  },
): InviteRow {
  const token = newInviteToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO invites
       (token, doc_uid, display_name, role, note, created_at, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, opts.docUid, opts.displayName, opts.role, opts.note, now, opts.createdByName);
  return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow;
}

function toInviteWire(row: InviteRow): Record<string, unknown> {
  return {
    token: row.token,
    display_name: row.display_name,
    role: row.role,
    note: row.note,
    created_at: row.created_at,
    created_by_name: row.created_by_name,
    url: `/d/${row.doc_uid}/${row.token}`,
  };
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

function canEdit(role: Role): boolean {
  return role === 'admin' || role === 'editor';
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
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 80) : null;
}

function asRole(v: unknown): InviteRole | null {
  return v === 'admin' || v === 'editor' || v === 'reader' ? v : null;
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}
