import { Hono } from 'hono';
import type { Context } from 'hono';
import { render } from '@markdowner/renderer';
import type { Database } from 'bun:sqlite';
import type { GitStore } from '../git-store.js';
import type { ServerConfig } from '../config.js';
import type { CommentRow, DocumentRow } from '../db.js';
import { reanchor } from '../anchoring.js';
import {
  authorize,
  createSession,
  hashPassword,
  parseCookie,
  readIdentity,
  SESSION_COOKIE,
  verifyPassword,
  type Role,
} from '../auth.js';
import { newDocumentUid, newRecoveryToken } from '../ids.js';
import { randomBytes } from 'node:crypto';

export interface AppDeps {
  db: Database;
  store: GitStore;
  config: ServerConfig;
}

export function documentsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => createDocument(c, deps));
  r.get('/:uid', async (c) => getDocument(c, deps));
  r.put('/:uid', async (c) => updateDocument(c, deps));
  r.get('/:uid/history', async (c) => getHistory(c, deps));
  r.post('/:uid/auth', async (c) => authenticate(c, deps));
  r.post('/:uid/admin-recovery', async (c) => recoverAdmin(c, deps));

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
  const recoveryToken = newRecoveryToken();

  let passwordHash: string | null = null;
  let plaintextPassword: string | null = null;
  if (body.password_protected === true) {
    plaintextPassword = generatePassword();
    passwordHash = await hashPassword(plaintextPassword);
  }

  const editable = body.editable_by_anyone === true ? 1 : 0;
  const theme = typeof body.default_theme === 'string' ? body.default_theme : 'default-light';

  await store.write(uid, markdown, identity, 'upload');

  db.prepare(
    `INSERT INTO documents
       (uid, path, admin_client_id, admin_recovery_token, password_hash,
        editable_by_anyone, default_theme, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid,
    store.docPath(uid),
    identity.clientId,
    recoveryToken,
    passwordHash,
    editable,
    theme,
    now,
    now,
  );

  const response: Record<string, unknown> = {
    uid,
    admin_recovery_token: recoveryToken,
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
    source,
    rendered,
    editable_by_anyone: doc.editable_by_anyone === 1,
    default_theme: doc.default_theme,
    password_protected: doc.password_hash !== null,
    role: decision.role,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  });
}

// --- PUT /api/documents/:uid -----------------------------------------

async function updateDocument(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  if (!canEdit(decision.role)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  if (!body || typeof body.markdown !== 'string') {
    return c.json({ error: 'markdown-required' }, 400);
  }

  const { oid } = await store.write(doc.uid, body.markdown, identity, 'update');
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(Date.now(), doc.uid);

  // Re-anchor existing top-level comments against the new block map.
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

  return c.json({ oid });
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

// --- POST /api/documents/:uid/admin-recovery -------------------------

async function recoverAdmin(c: Context, { db }: AppDeps) {
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);

  const body = await safeJson(c);
  if (!body || typeof body.recovery_token !== 'string') {
    return c.json({ error: 'recovery-token-required' }, 400);
  }
  if (doc.admin_recovery_token === null || body.recovery_token !== doc.admin_recovery_token) {
    return c.json({ error: 'invalid-token' }, 401);
  }

  const newToken = newRecoveryToken();
  db.prepare(
    'UPDATE documents SET admin_client_id = ?, admin_recovery_token = ?, updated_at = ? WHERE uid = ?',
  ).run(identity.clientId, newToken, Date.now(), doc.uid);

  return c.json({ admin_recovery_token: newToken });
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
  const identity = readIdentity(c.req.raw.headers);
  const sessionToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
  return authorize(deps.db, doc, identity, sessionToken);
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

/** Human-friendly autogenerated password: 4 groups of 4 base32-ish chars. */
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
