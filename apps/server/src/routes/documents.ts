import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  exportDocx,
  extractDocumentTitle,
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  renderDocument,
  rewriteAssetReferences,
  sanitizeDocumentFilename,
} from '@marginalia/renderer';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { reanchor } from '../anchoring.js';
import { reanchorProposals } from './edit-proposals.js';
import {
  type Identity,
  SESSION_COOKIE,
  authorize,
  canEdit,
  createSession,
  hashPassword,
  parseCookie,
  readIdentity,
  verifyPassword,
} from '../auth.js';
import type { BlobStore } from '../blob-store.js';
import type { ServerConfig } from '../config.js';
import { gcAssetIfOrphan, listAttached } from './assets.js';
import type {
  CommentRow,
  DocumentFormat,
  DocumentRow,
  InviteKind,
  InviteRole,
  InviteRow,
} from '../db.js';
import { isDocumentFormat, isInviteKind, isInviteRole } from '../db.js';
import type { GitStore } from '../git-store.js';
import { newDocumentUid, newInviteToken } from '../ids.js';
import type { Realtime } from '../realtime.js';

export interface AppDeps {
  db: Database;
  store: GitStore;
  blobs: BlobStore;
  config: ServerConfig;
  realtime: Realtime;
}

export function documentsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => createDocument(c, deps));
  r.post('/import', async (c) => importDocument(c, deps));
  r.get('/:uid', async (c) => getDocument(c, deps));
  r.get('/:uid/export', async (c) => exportDocument(c, deps));
  r.get('/:uid/export.docx', async (c) => exportDocumentAsDocx(c, deps));
  r.put('/:uid', async (c) => updateDocument(c, deps));
  r.patch('/:uid/settings', async (c) => updateSettings(c, deps));
  r.delete('/:uid', async (c) => deleteDocument(c, deps));
  r.get('/:uid/history', async (c) => getHistory(c, deps));
  r.post('/:uid/auth', async (c) => authenticate(c, deps));

  r.get('/:uid/invites', async (c) => listInvites(c, deps));
  r.post('/:uid/invites', async (c) => createInvite(c, deps));
  r.post('/:uid/invites/admin/rotate', async (c) => rotateAdminInvite(c, deps));
  r.delete('/:uid/invites/:token', async (c) => deleteInvite(c, deps));

  return r;
}

// --- POST /api/documents ---------------------------------------------

async function createDocument(c: Context, { db, store }: AppDeps) {
  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  // Accept `source` as the format-neutral field name, and keep `markdown`
  // working for old clients still using that key.
  const sourceRaw = typeof body.source === 'string' ? body.source : body.markdown;
  if (typeof sourceRaw !== 'string' || sourceRaw.length === 0) {
    return c.json({ error: 'source-required' }, 400);
  }
  const format: DocumentFormat = isDocumentFormat(body.format) ? body.format : 'markdown';

  const uid = newDocumentUid();
  const now = Date.now();

  let passwordHash: string | null = null;
  let plaintextPassword: string | null = null;
  if (body.password_protected === true) {
    plaintextPassword = generatePassword();
    passwordHash = await hashPassword(plaintextPassword);
  }

  const theme = typeof body.default_theme === 'string' ? body.default_theme : 'default';
  const docName =
    typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim().slice(0, 200)
      : null;

  const { path } = await store.write(uid, format, sourceRaw, identity, 'upload');

  // editable_by_anyone is deprecated; always 0 on new rows, unread by authorize().
  db.prepare(
    `INSERT INTO documents
       (uid, path, name, password_hash, editable_by_anyone, default_theme, format, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(uid, path, docName, passwordHash, theme, format, now, now);

  // Every doc gets an admin invite for its creator. The returned URL is the
  // admin's canonical way to come back to the doc.
  const adminInvite = createInviteRow(db, {
    docUid: uid,
    displayName: identity.displayName,
    role: 'admin',
    kind: 'admin',
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
    format,
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

  const source = store.read(doc.path);
  const rendered = await renderDocument(source, doc.format);
  const attached = listAttached(db, doc.uid);
  rendered.html = await rewriteAssetReferences(rendered.html, {
    docUid: doc.uid,
    attached: new Set(attached.map((a) => a.ref_name)),
  });

  // For admin/named invites: the server-resolved current name (invite
  // seed on first visit, doc_users row after). For generic/no-invite:
  // null. Client uses this to keep localStorage in sync with the server.
  const forcedDisplayName =
    decision.invite && decision.invite.kind !== 'generic'
      ? decision.identity?.displayName ?? null
      : null;
  return c.json({
    uid: doc.uid,
    name: doc.name,
    source,
    rendered,
    attached_assets: attached,
    format: doc.format,
    default_theme: doc.default_theme,
    password_protected: doc.password_hash !== null,
    role: decision.role,
    display_name: forcedDisplayName,
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
  // Accept `source` going forward but keep `markdown` for legacy callers.
  const nextSource = typeof body?.source === 'string' ? body.source : body?.markdown;
  if (typeof nextSource !== 'string') {
    return c.json({ error: 'source-required' }, 400);
  }

  let previousSource = '';
  try {
    previousSource = store.read(doc.path);
  } catch {
    /* new doc */
  }

  const { oid } = await store.write(doc.uid, doc.format, nextSource, decision.identity, 'update');
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(Date.now(), doc.uid);

  const rendered = await renderDocument(nextSource, doc.format);
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

  // Include sub-block ids so proposals on list items / table cells don't
  // get orphaned after every save. Markdown uses the mdast-based locator;
  // asciidoc hands off to its own pipeline, and its locator also emits
  // sub-block ids for supported nested structures (e.g. list items).
  const knownIds =
    doc.format === 'asciidoc'
      ? [...locateAllBlocksAsciidoc(nextSource).keys()]
      : [...locateAllBlocks(nextSource).keys()];
  reanchorProposals(db, doc.uid, knownIds, now, realtime, decision.identity.clientId);

  if (isContentChange(previousSource, nextSource)) {
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
  const { db, config } = deps;
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
  let shouldRefreshSession = false;

  // editable_by_anyone is unsettable; tolerated on incoming payloads for
  // back-compat with old clients.
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
    shouldRefreshSession = true;
  }

  if (updates.length === 0) return c.json({ error: 'no-updates' }, 400);

  const set = updates.map(([k]) => `${k} = ?`).join(', ');
  const vals: Bind[] = updates.map(([, v]) => v);
  db.prepare(`UPDATE documents SET ${set}, updated_at = ? WHERE uid = ?`).run(
    ...vals,
    Date.now(),
    doc.uid,
  );

  const fresh = loadDoc(db, doc.uid);
  if (!fresh) return c.json({ error: 'not-found' }, 404);
  const response: Record<string, unknown> = {
    name: fresh.name,
    default_theme: fresh.default_theme,
    password_protected: fresh.password_hash !== null,
  };
  if (plaintextPassword) response.password = plaintextPassword;
  if (shouldRefreshSession) {
    // Keep the initiating admin authenticated under the newly-rotated
    // password while invalidating every previously-issued session.
    setSessionCookie(c, db, doc.uid, config.sessionTtlMs);
  }
  return c.json(response);
}

// --- DELETE /api/documents/:uid (admin only) -------------------------

async function deleteDocument(c: Context, deps: AppDeps) {
  const { db, store, blobs } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  // Capture the asset ids about to be detached so we can GC the blobs
  // afterwards if no other doc still references them.
  const attachedAssetIds = (
    db
      .prepare('SELECT DISTINCT asset_id FROM document_assets WHERE doc_uid = ?')
      .all(doc.uid) as Array<{ asset_id: string }>
  ).map((r) => r.asset_id);

  // Drop everything the server stores about the doc. Order doesn't matter
  // (no FKs declared). Must list every per-doc table; orphans here would
  // leak author history + in-flight proposals after the doc is gone.
  db.prepare('DELETE FROM comments WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM comment_mentions WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM edit_proposals WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM doc_users WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM invites WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM sessions WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM document_assets WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM documents WHERE uid = ?').run(doc.uid);

  for (const id of attachedAssetIds) {
    await gcAssetIfOrphan(db, blobs, id);
  }

  try {
    await store.deleteDoc(doc.path, doc.uid, decision.identity);
  } catch {
    /* repo file already missing — fine */
  }

  return c.body(null, 204);
}

// --- GET /api/documents/:uid/export (portable bundle) ----------------

async function exportDocument(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const source = store.read(doc.path);
  const rendered = await renderDocument(source, doc.format);
  const comments = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
    )
    .all(doc.uid) as CommentRow[];

  const bundle = {
    version: 3 as const,
    kind: 'marginalia.document-bundle',
    exported_at: Date.now(),
    document: {
      name: doc.name,
      source,
      format: doc.format,
      // editable_by_anyone is preserved in exports for one release so old
      // tooling can still read bundles. The field is meaningless on import.
      editable_by_anyone: doc.editable_by_anyone === 1,
      default_theme: doc.default_theme,
    },
    representation: {
      frontmatter: rendered.frontmatter,
      anchors: rendered.anchors,
      toc: rendered.toc,
      assets: rendered.assets,
      mermaid: rendered.mermaid,
      blocks: rendered.blocks,
      warnings: rendered.warnings,
    },
    comments: comments.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      anchor_block_id: row.anchor_block_id,
      anchor_quote: row.anchor_quote,
      anchor_prefix: row.anchor_prefix,
      anchor_suffix: row.anchor_suffix,
      anchor_start_offset: row.anchor_start_offset,
      anchor_end_offset: row.anchor_end_offset,
      anchor_heading_path: parseStringArray(row.anchor_heading_path),
      anchor_section_index: row.anchor_section_index,
      anchor_section_index_path: parseNumberArray(row.anchor_section_index_path),
      author_client_id: row.author_client_id,
      author_display_name: row.author_display_name,
      body: row.body,
      status: row.status,
      resolved_at: row.resolved_at,
      resolved_by_name: row.resolved_by_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  };

  const filename = (doc.name ?? doc.uid).replace(/[^\w.-]+/g, '_').slice(0, 80);
  c.header('Content-Disposition', `attachment; filename="${filename}.marginalia.json"`);
  return c.json(bundle);
}

// --- GET /api/documents/:uid/export.docx -----------------------------

/**
 * DOCX export. Produces a themed Word document from the stored source.
 *
 * Theme resolution: `?theme=<id>` wins; otherwise we fall back to the
 * document's `default_theme`. Unknown ids fall back to 'default' inside
 * the exporter (matches the web viewer's behavior).
 *
 * Title/author: the document name and the caller's display name are
 * forwarded to DOCX core properties so Word's File > Info surfaces
 * sensible metadata. These are best-effort — if the name is missing
 * we omit the field entirely.
 */
async function exportDocumentAsDocx(c: Context, deps: AppDeps) {
  const { db, store, blobs } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const identity = readIdentity(c.req.raw.headers);
  const themeParam = c.req.query('theme');
  const theme = typeof themeParam === 'string' && themeParam.length > 0
    ? themeParam
    : (doc.default_theme ?? 'default');

  // Build an asset-resolver scoped to this document so markdown `<img>`
  // srcs that match an attached ref land as real embedded images in the
  // DOCX. Absolute http(s) URLs are not followed — the server only
  // serves bytes it owns. data: URLs don't reach this resolver; the
  // exporter decodes those inline.
  const attached = new Map<string, { assetId: string; mime: string }>();
  for (const a of listAttached(db, doc.uid)) {
    attached.set(a.ref_name, { assetId: a.asset_id, mime: a.mime });
  }

  const source = store.read(doc.path);
  // Title resolution for both the DOCX core properties and the
  // download filename: explicit `doc.name` wins; else the document's
  // own title (frontmatter `title:` or first H1 / `= Header`); else
  // the opaque uid. Matches what a human would expect the file to be
  // called when they open it.
  const derivedTitle = doc.name ?? extractDocumentTitle(source, doc.format);
  const buf = await exportDocx(source, {
    theme,
    format: doc.format,
    ...(derivedTitle ? { title: derivedTitle } : {}),
    ...(identity?.displayName ? { author: identity.displayName } : {}),
    resolveAsset: async (src) => {
      const hit = attached.get(src);
      if (!hit) return null;
      try {
        const bytes = await blobs.get(hit.assetId);
        return { bytes, mime: hit.mime };
      } catch {
        // Blob missing on disk (rare — shouldn't happen without a GC
        // bug). Swallow so the export still succeeds with a placeholder.
        return null;
      }
    },
  });

  const filename = sanitizeDocumentFilename(derivedTitle, doc.uid);
  c.header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  c.header('Content-Disposition', `attachment; filename="${filename}.docx"`);
  c.header('Cache-Control', 'private, no-store');
  // `nosniff` matches the asset route: stops the browser from
  // guessing a more permissive content type based on the bytes,
  // which closes a class of user-upload XSS paths even though Word
  // ignores it. Defense in depth.
  c.header('X-Content-Type-Options', 'nosniff');
  // Hono doesn't have a first-class Buffer helper; return a Uint8Array
  // so the underlying Response pipeline sends exact bytes.
  return c.body(new Uint8Array(buf));
}

// --- POST /api/documents/import (consume a bundle) -------------------

async function importDocument(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);

  const bundle = (await safeJson(c)) as Record<string, unknown> | null;
  if (!bundle || bundle.kind !== 'marginalia.document-bundle' || !isBundleVersion(bundle.version)) {
    return c.json({ error: 'invalid-bundle' }, 400);
  }
  const docSpec = bundle.document as Record<string, unknown> | undefined;
  if (!docSpec || typeof docSpec.source !== 'string') {
    return c.json({ error: 'invalid-bundle-document' }, 400);
  }

  const uid = newDocumentUid();
  const now = Date.now();
  const name =
    typeof docSpec.name === 'string' && docSpec.name.trim().length > 0
      ? docSpec.name.trim().slice(0, 200)
      : null;
  const theme = typeof docSpec.default_theme === 'string' ? docSpec.default_theme : 'default';
  const format: DocumentFormat = isDocumentFormat(docSpec.format) ? docSpec.format : 'markdown';
  // Bundle's editable_by_anyone is ignored; the column is deprecated.

  const { path } = await store.write(uid, format, docSpec.source, identity, 'upload');
  db.prepare(
    `INSERT INTO documents
       (uid, path, name, password_hash, editable_by_anyone, default_theme, format, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
  ).run(uid, path, name, theme, format, now, now);

  // Fresh admin invite for the importer — not re-using the one from the
  // bundle (tokens are tied to specific deployments / user IDs).
  const adminInvite = createInviteRow(db, {
    docUid: uid,
    displayName: identity.displayName,
    role: 'admin',
    kind: 'admin',
    note: 'Imported',
    createdByName: identity.displayName,
  });

  // Best-effort comment import. We keep original authorship (client_id +
  // display_name) so comments still belong to the original user identities,
  // but regenerate comment IDs because the `id` column is a global primary
  // key — the original and the re-import can easily coexist in the same DB.
  // Parent_ids get remapped through the same translation table.
  let importedComments = 0;
  const commentRows = Array.isArray(bundle.comments) ? bundle.comments : [];
  const idMap = new Map<string, string>();
  for (const raw of commentRows) {
    const row = raw as Record<string, unknown>;
    if (typeof row.id === 'string') {
      idMap.set(row.id, randomBytes(12).toString('base64url'));
    }
  }
  const insertComment = db.prepare(
    `INSERT INTO comments
       (id, doc_uid, parent_id,
        anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
        anchor_start_offset, anchor_end_offset,
        anchor_heading_path, anchor_section_index, anchor_section_index_path,
        author_client_id, author_display_name, body, status,
        resolved_at, resolved_by_name,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const raw of commentRows) {
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.author_client_id !== 'string' ||
      typeof row.author_display_name !== 'string' ||
      typeof row.body !== 'string'
    ) {
      continue;
    }
    const newId = idMap.get(row.id);
    if (!newId) continue;
    const parentOldId = typeof row.parent_id === 'string' ? row.parent_id : null;
    const newParentId = parentOldId ? (idMap.get(parentOldId) ?? null) : null;
    insertComment.run(
      newId,
      uid,
      newParentId,
      typeof row.anchor_block_id === 'string' ? row.anchor_block_id : null,
      typeof row.anchor_quote === 'string' ? row.anchor_quote : null,
      typeof row.anchor_prefix === 'string' ? row.anchor_prefix : null,
      typeof row.anchor_suffix === 'string' ? row.anchor_suffix : null,
      typeof row.anchor_start_offset === 'number' ? row.anchor_start_offset : null,
      typeof row.anchor_end_offset === 'number' ? row.anchor_end_offset : null,
      normalizeStringArrayJson(row.anchor_heading_path),
      typeof row.anchor_section_index === 'number' ? row.anchor_section_index : null,
      normalizeNumberArrayJson(row.anchor_section_index_path),
      row.author_client_id,
      row.author_display_name,
      row.body,
      typeof row.status === 'string' ? row.status : 'active',
      typeof row.resolved_at === 'number' ? row.resolved_at : null,
      typeof row.resolved_by_name === 'string' ? row.resolved_by_name : null,
      typeof row.created_at === 'number' ? row.created_at : now,
      typeof row.updated_at === 'number' ? row.updated_at : now,
    );
    importedComments += 1;
  }

  return c.json(
    {
      uid,
      name,
      admin_invite: {
        token: adminInvite.token,
        url: `/d/${uid}/${adminInvite.token}`,
        display_name: adminInvite.display_name,
      },
      imported_comments: importedComments,
    },
    201,
  );
}

function isBundleVersion(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}

function parseStringArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function parseNumberArray(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((item): item is number => typeof item === 'number') : null;
  } catch {
    return null;
  }
}

function normalizeStringArrayJson(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v.filter((item): item is string => typeof item === 'string'));
}

function normalizeNumberArrayJson(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v.filter((item): item is number => typeof item === 'number'));
}

// --- GET /api/documents/:uid/history ---------------------------------

async function getHistory(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const history = await store.history(doc.path);
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

  setSessionCookie(c, db, doc.uid, config.sessionTtlMs);
  return c.body(null, 204);
}

function setSessionCookie(c: Context, db: Database, docUid: string, ttlMs: number): void {
  const token = createSession(db, docUid, ttlMs);
  const maxAge = Math.floor(ttlMs / 1000);
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
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

  // Default 'named' for back-compat with old clients that always sent a
  // display_name. Generic is explicit opt-in.
  const rawKind = typeof body.kind === 'string' ? body.kind : 'named';
  if (!isInviteKind(rawKind)) return c.json({ error: 'invalid-kind' }, 400);
  if (rawKind === 'admin') {
    // Admin invites come only from upload + /admin/rotate. A second
    // admin row here would be undeletable (see deleteInvite).
    return c.json({ error: 'admin-invite-not-creatable' }, 400);
  }

  const role = asRole(body.role);
  if (!role) return c.json({ error: 'role-required' }, 400);
  // Never let the caller grant `admin` through this endpoint either —
  // defense in depth; asRole is a simple validator, not an authorizer.
  if (role === 'admin') return c.json({ error: 'admin-role-not-grantable' }, 400);

  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;

  let displayName: string | null;
  if (rawKind === 'named') {
    displayName = asString(body.display_name);
    if (!displayName) return c.json({ error: 'display_name-required' }, 400);
  } else {
    // generic: visitor brings their own name; the invite's display_name
    // is irrelevant. Silently drop anything the caller sent.
    displayName = null;
  }

  const row = createInviteRow(db, {
    docUid: doc.uid,
    displayName,
    role,
    kind: rawKind,
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

  const row = db
    .prepare('SELECT * FROM invites WHERE token = ? AND doc_uid = ?')
    .get(token, doc.uid) as InviteRow | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);
  // Admin invites aren't revocable — the author keeps their ability to
  // come back to the doc. If admins ever become shareable between people,
  // removing that control must go through a dedicated "transfer admin"
  // flow rather than a plain delete.
  if (row.role === 'admin') {
    return c.json({ error: 'admin-invite-not-deletable' }, 403);
  }

  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
  return c.body(null, 204);
}

/**
 * Revoke the current admin token, mint a fresh one, carry display_name +
 * role over. Response mirrors upload's `admin_invite` shape.
 */
async function rotateAdminInvite(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (decision.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  // `existing` is just a hint for carrying over display_name/note onto
  // the new row; the DELETE below wipes EVERY admin-kind row, not just
  // this one. That matters because a legacy DB migrated in from before
  // kind='admin' was introduced could have multiple admin-kind rows
  // (the pre-Step-3 POST /invites accepted role='admin' from the admin
  // UI, and migrateInvitesKind backfills kind from role). If we only
  // dropped one row here, rotate wouldn't reliably revoke a leaked
  // admin URL — which is the entire reason the button exists.
  const existing = db
    .prepare(`SELECT * FROM invites WHERE doc_uid = ? AND kind = 'admin' LIMIT 1`)
    .get(doc.uid) as InviteRow | undefined;
  // Insert-then-delete so the doc is never admin-less between steps.
  const fresh = createInviteRow(db, {
    docUid: doc.uid,
    displayName: existing?.display_name ?? decision.identity.displayName,
    role: 'admin',
    kind: 'admin',
    note: existing?.note ?? 'Author',
    createdByName: decision.identity.displayName,
  });
  db.prepare(
    `DELETE FROM invites WHERE doc_uid = ? AND kind = 'admin' AND token != ?`,
  ).run(doc.uid, fresh.token);
  return c.json({
    admin_invite: {
      token: fresh.token,
      url: `/d/${doc.uid}/${fresh.token}`,
      display_name: fresh.display_name,
    },
  });
}

function createInviteRow(
  db: Database,
  opts: {
    docUid: string;
    displayName: string | null;
    role: InviteRole;
    kind: InviteKind;
    note: string | null;
    createdByName: string;
  },
): InviteRow {
  const token = newInviteToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO invites
       (token, doc_uid, display_name, role, kind, note, created_at, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    opts.docUid,
    opts.displayName,
    opts.role,
    opts.kind,
    opts.note,
    now,
    opts.createdByName,
  );
  return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow;
}

function toInviteWire(row: InviteRow): Record<string, unknown> {
  return {
    token: row.token,
    display_name: row.display_name,
    role: row.role,
    kind: row.kind,
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
  return isInviteRole(v) ? v : null;
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    out += alphabet[byte % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}
