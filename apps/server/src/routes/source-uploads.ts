import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  authorize,
  canEdit,
  INVITE_SESSION_COOKIE,
  needsName,
  parseCookie,
  type Role,
  SESSION_COOKIE,
} from '../auth.js';
import type { DocumentRow } from '../db.js';
import { newUploadToken } from '../ids.js';
import { AGENT_KEY_HEADER, hashAgentKey } from './agent-keys.js';
import { type AppDeps, afterSourceSaved, cleanCommitMessage } from './documents.js';

/**
 * Replace a document's source from a file, by URL: for an agent whose
 * tool calls would otherwise have to carry the whole document as text it
 * generates, which is slow, capped in size and not byte-exact. The URL
 * also serves the source it is bound to, so the round trip — download,
 * edit on disk, upload — never passes the text through the model.
 */

/** Long enough to download, edit and upload; short enough to be dead in a transcript. */
const SOURCE_UPLOAD_TTL_MS = 30 * 60 * 1000;
/** Unused URLs one document may have at once, against a minting loop. */
const MAX_OPEN_SOURCE_UPLOADS = 20;

interface SourceUploadTicketRow {
  token_hash: string;
  doc_uid: string;
  base_hash: string;
  commit_message: string | null;
  client_id: string;
  created_by: string;
  invite_token: string | null;
  agent_id: string | null;
  expires_at: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Mounted at `/api/documents`, beside the document's other routes. */
export function sourceUploadMintRouter(deps: AppDeps): Hono {
  const r = new Hono();
  r.post('/:uid/source-uploads', async (c) => mintSourceUpload(c, deps));
  return r;
}

/** Mounted at `/api`: the request carries no invite, the URL is the whole capability. */
export function sourceUploadsRouter(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/source-uploads/:token', async (c) => downloadBase(c, deps));
  r.post('/source-uploads/:token', async (c) => uploadSource(c, deps));
  return r;
}

/**
 * POST /:uid/source-uploads — one URL, bound to the source as it is now.
 * Needs what saving needs, editor or admin, and binds the uploader's
 * identity at minting, so the commit is attributed as a direct save is.
 */
async function mintSourceUpload(c: Context, deps: AppDeps) {
  const { db, store, config } = deps;
  const doc = loadDoc(deps, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const cookie = c.req.raw.headers.get('cookie');
  const decision = authorize(
    db,
    doc,
    c.req.raw.headers,
    parseCookie(cookie, SESSION_COOKIE),
    parseCookie(cookie, INVITE_SESSION_COOKIE),
  );
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  const { identity } = decision;
  if (!identity) return c.json({ error: 'identity-required' }, 400);
  if (needsName(decision)) return c.json({ error: 'display-name-required' }, 409);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as { commit_message?: unknown } | null;
  const commitMessage =
    typeof body?.commit_message === 'string' ? cleanCommitMessage(body.commit_message) : undefined;

  let source: string;
  try {
    source = store.read(doc);
  } catch {
    return c.json({ error: 'not-found' }, 404);
  }

  const now = Date.now();
  const expiresAt = now + SOURCE_UPLOAD_TTL_MS;
  // The invite may be the creator's admin link, which outlives the agent
  // that used it; the key is what revoking the agent ends.
  const agentKey = c.req.header(AGENT_KEY_HEADER);
  const agent = agentKey
    ? (db
        .prepare('SELECT id FROM keyring_agents WHERE key_hash = ?')
        .get(hashAgentKey(agentKey)) as {
        id: string;
      } | null)
    : null;
  const token = db.transaction(() => {
    db.prepare('DELETE FROM source_upload_tickets WHERE expires_at < ?').run(now);
    const { open } = db
      .prepare('SELECT count(*) AS open FROM source_upload_tickets WHERE doc_uid = ?')
      .get(doc.uid) as { open: number };
    if (open >= MAX_OPEN_SOURCE_UPLOADS) return null;
    const minted = newUploadToken();
    db.prepare(
      `INSERT INTO source_upload_tickets
         (token_hash, doc_uid, base_hash, commit_message, client_id, created_by,
          invite_token, agent_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(minted),
      doc.uid,
      hash(source),
      commitMessage ?? null,
      identity.clientId,
      identity.displayName,
      decision.invite?.token ?? null,
      agent?.id ?? null,
      expiresAt,
    );
    return minted;
  })();
  if (!token) {
    return c.json({ error: 'too-many-upload-urls', max: MAX_OPEN_SOURCE_UPLOADS }, 429);
  }

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      url: `/api/source-uploads/${token}`,
      expires_at: expiresAt,
      max_bytes: config.maxAssetBytes,
      format: doc.format,
      bytes: Buffer.byteLength(source),
      lines: source.split('\n').length,
    },
    201,
  );
}

type Ticket =
  | { ok: true; ticket: SourceUploadTicketRow; doc: DocumentRow }
  | { ok: false; status: 404; error: 'upload-url-invalid' };

function loadTicket(deps: AppDeps, token: string): Ticket {
  const { db } = deps;
  const invalid = { ok: false, status: 404, error: 'upload-url-invalid' } as const;
  const ticket = db
    .prepare('SELECT * FROM source_upload_tickets WHERE token_hash = ?')
    .get(hash(token)) as SourceUploadTicketRow | null;
  if (!ticket || ticket.expires_at < Date.now()) return invalid;
  // Deleting the invite that minted it revokes the URL with it, and so does
  // demoting it: unlike an image upload URL, this one overwrites the source.
  if (ticket.invite_token) {
    const invite = db
      .prepare('SELECT role FROM invites WHERE token = ?')
      .get(ticket.invite_token) as { role: Role } | null;
    if (!invite || !canEdit(invite.role)) {
      db.prepare('DELETE FROM source_upload_tickets WHERE token_hash = ?').run(ticket.token_hash);
      return invalid;
    }
  }
  const doc = loadDoc(deps, ticket.doc_uid);
  return doc ? { ok: true, ticket, doc } : invalid;
}

/**
 * The URL is dead once the document has moved past its base: whatever
 * the caller edited started from a source that is no longer current.
 */
function documentChanged(c: Context, deps: AppDeps, ticket: SourceUploadTicketRow) {
  deps.db.prepare('DELETE FROM source_upload_tickets WHERE token_hash = ?').run(ticket.token_hash);
  return c.json(
    {
      error: 'document-changed',
      message:
        'The document changed after this URL was issued. Request a new one, download the ' +
        'current source with it and apply your edits there.',
    },
    409,
  );
}

/** GET /api/source-uploads/:token — the source the URL is bound to, exactly. */
async function downloadBase(c: Context, deps: AppDeps) {
  const loaded = loadTicket(deps, c.req.param('token') ?? '');
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
  const { ticket, doc } = loaded;
  const source = deps.store.read(doc);
  if (hash(source) !== ticket.base_hash) return documentChanged(c, deps, ticket);
  return c.body(source, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

/**
 * POST /api/source-uploads/:token — the new source, as multipart `file`
 * (`curl -F file=@doc.md`) or as the raw body (`--data-binary @doc.md`).
 */
async function uploadSource(c: Context, deps: AppDeps) {
  const { db, store, config } = deps;
  const loaded = loadTicket(deps, c.req.param('token') ?? '');
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
  const { ticket, doc } = loaded;

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > config.maxAssetBytes) {
    return c.json({ error: 'file-too-large', limit: config.maxAssetBytes }, 413);
  }
  let bytes: Uint8Array;
  if ((c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: 'invalid-form' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'file-required' }, 400);
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }
  if (bytes.byteLength > config.maxAssetBytes) {
    return c.json({ error: 'file-too-large', limit: config.maxAssetBytes }, 413);
  }
  let next: string;
  try {
    next = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return c.json({ error: 'not-utf8' }, 400);
  }
  // An empty upload is far likelier a wrong path or a failed pipe than an
  // intent to blank the document.
  if (next.trim() === '') return c.json({ error: 'file-required' }, 400);

  const previous = store.read(doc);
  if (hash(previous) !== ticket.base_hash) return documentChanged(c, deps, ticket);

  // Claimed by the delete itself, so two racing uploads cannot both use it.
  const claimed = db
    .prepare('DELETE FROM source_upload_tickets WHERE token_hash = ?')
    .run(ticket.token_hash);
  if (claimed.changes !== 1) return c.json({ error: 'upload-url-invalid' }, 404);

  const lines = { before: previous.split('\n').length, after: next.split('\n').length };
  if (next === previous) return c.json({ unchanged: true, lines });

  const identity = { clientId: ticket.client_id, displayName: ticket.created_by };
  const written = await store.writeIfCurrent(
    doc,
    previous,
    next,
    identity,
    'update',
    ticket.commit_message ? { commitMessage: ticket.commit_message } : undefined,
  );
  if (!written) return documentChanged(c, deps, ticket);
  await afterSourceSaved(deps, doc, previous, next, written.oid, identity);
  return c.json({ oid: written.oid, lines }, 201);
}

function loadDoc(deps: AppDeps, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  return (
    (deps.db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
      | DocumentRow
      | undefined) ?? null
  );
}
