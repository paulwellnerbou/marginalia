import type { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  exportDocx,
  extractDocumentTitle,
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  renderDocument,
  rewriteAssetReferences,
  sanitizeDocumentFilename,
} from '@marginalia/renderer';
import type { BlockSourceRange } from '@marginalia/renderer';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { reanchor } from '../anchoring.js';
import { mapWithConcurrency } from '../concurrency.js';
import {
  loadProposalRow,
  reopenAcceptedProposal,
  reanchorProposals,
  readProposalContent,
  toWire as toEditProposalWire,
} from './edit-proposals.js';
import {
  type Identity,
  INVITE_SESSION_COOKIE,
  SESSION_COOKIE,
  authorize,
  canEdit,
  createSession,
  deleteSession,
  hashPassword,
  parseCookie,
  readIdentity,
  readInvite,
  readSession,
  verifyPassword,
} from '../auth.js';
import type { BlobStore } from '../blob-store.js';
import type { ServerConfig } from '../config.js';
import { gcAssetIfOrphan, listAttached } from './assets.js';
import type {
  CommentRow,
  DocumentFormat,
  DocumentRow,
  EditProposalStatus,
  InviteKind,
  InviteRole,
  InviteRow,
} from '../db.js';
import { isDocumentFormat, isInviteKind, isInviteRole, isMermaidRenderer } from '../db.js';
import type { MermaidRenderer } from '../db.js';
import type { HistoryEntry as GitHistoryEntry, GitStore } from '../git-store.js';
import { newDocumentUid, newInviteToken } from '../ids.js';
import type { Realtime } from '../realtime.js';
import { listDocUserNameMap, upsertDocUser } from '../users.js';
import {
  ExportBusyError,
  ExportEngineMissingError,
  ExportTimeoutError,
  exportPdf,
} from '../export/pdf.js';
import {
  countLiveMermaidBlocks,
  inlineImageAssets,
  type MermaidPrerasterResolver,
  prerasterizeMermaid,
} from '../export/html-envelope.js';
import { renderMermaidWithChromium } from '../export/mermaid-chromium.js';
import {
  MermaidRenderEngineMissingError,
  type MermaidImageFormat,
  renderMermaidToImage,
  type RenderedMermaidImage,
} from '../export/mermaid-rust.js';
import { loadPrintCss, loadThemeCss } from '../export/theme-css.js';

// ---------------------------------------------------------------------
// Mermaid renderer dispatch
// ---------------------------------------------------------------------

/**
 * Resolve the effective renderer for an export request.
 *
 * Order:
 *   1. `?mermaid=mmdr|chromium` query — ad-hoc preview override.
 *   2. Per-document `mermaid_renderer` column.
 *   3. Server-wide default from `MARGINALIA_MERMAID_RENDERER_DEFAULT`.
 *   4. Hard-coded `'mmdr'`.
 *
 * Returns the choice + a short label for telemetry / log lines.
 */
function effectiveMermaidRenderer(
  doc: DocumentRow,
  c: Context,
): MermaidRenderer {
  const queryRaw = c.req.query('mermaid');
  if (typeof queryRaw === 'string' && isMermaidRenderer(queryRaw)) return queryRaw;
  if (doc.mermaid_renderer) return doc.mermaid_renderer;
  const envRaw = process.env.MARGINALIA_MERMAID_RENDERER_DEFAULT;
  if (envRaw && isMermaidRenderer(envRaw)) return envRaw;
  return 'mmdr';
}

/**
 * Wrap a renderer (mmdr / chromium) in the swallow-and-fall-back
 * policy shared by every export caller: parse / render errors return
 * `null` so the per-block fallback fires; engine-missing logs once
 * per export (closure captured in the calling route) and returns
 * `null` so the export still succeeds with placeholders.
 *
 * `format` is the bytes shape the caller wants: PNG for DOCX,
 * SVG for the PDF pre-rasterizer (mmdr path).
 */
function makeMermaidResolver(
  choice: MermaidRenderer,
  format: MermaidImageFormat,
  onceWarn: (msg: string) => void,
): (source: string) => Promise<RenderedMermaidImage | null> {
  const impl =
    choice === 'chromium' ? renderMermaidWithChromium : renderMermaidToImage;
  return async (source) => {
    try {
      return await impl(source, format);
    } catch (err) {
      if (err instanceof MermaidRenderEngineMissingError) {
        onceWarn(err.message);
        return null;
      }
      // Render / timeout errors fall back to placeholder too.
      return null;
    }
  };
}

export interface AppDeps {
  db: Database;
  store: GitStore;
  blobs: BlobStore;
  config: ServerConfig;
  realtime: Realtime;
}

interface BundleCommentRow extends CommentRow {
  proposal_status: EditProposalStatus | null;
  accepted_oid: string | null;
  branch_ref: string | null;
  base_oid: string | null;
  base_block_start: number | null;
  base_block_end: number | null;
}

export function documentsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => createDocument(c, deps));
  r.post('/import', async (c) => importDocument(c, deps));
  r.get('/:uid', async (c) => getDocument(c, deps));
  r.get('/:uid/export', async (c) => exportDocument(c, deps));
  r.get('/:uid/export.docx', async (c) => exportDocumentAsDocx(c, deps));
  r.get('/:uid/export.pdf', async (c) => exportDocumentAsPdf(c, deps));
  r.put('/:uid', async (c) => updateDocument(c, deps));
  r.patch('/:uid/settings', async (c) => updateSettings(c, deps));
  r.delete('/:uid', async (c) => deleteDocument(c, deps));
  r.get('/:uid/history', async (c) => getHistory(c, deps));
  r.get('/:uid/history/:oid/diff', async (c) => getHistoryDiff(c, deps));
  r.post('/:uid/history/:oid/restore', async (c) => restoreHistoryVersion(c, deps));
  r.post('/:uid/history/:oid/revert', async (c) => revertLatestHistoryVersion(c, deps));
  r.post('/:uid/auth', async (c) => authenticate(c, deps));
  r.post('/:uid/logout', async (c) => logout(c, deps));
  r.post('/:uid/password/recover', async (c) => recoverCurrentPassword(c, deps));

  r.get('/:uid/invites', async (c) => listInvites(c, deps));
  r.post('/:uid/invites', async (c) => createInvite(c, deps));
  r.post('/:uid/invites/admin/rotate', async (c) => rotateAdminInvite(c, deps));
  r.post('/:uid/invites/:token/claim', async (c) => claimInvite(c, deps));
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

  await store.write({ uid, format }, sourceRaw, identity, 'upload');

  // editable_by_anyone is deprecated; always 0 on new rows, unread by authorize().
  db.prepare(
    `INSERT INTO documents
       (uid, repo_dir, name, password_hash, editable_by_anyone, default_theme, format, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(uid, uid, docName, passwordHash, theme, format, now, now);
  upsertDocUser(db, uid, identity);

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
  if (plaintextPassword) {
    const recovery = encryptRecoverablePassword(plaintextPassword, uid, adminInvite.token);
    db.prepare(
      `UPDATE documents
          SET password_recovery_ciphertext = ?, password_recovery_iv = ?
        WHERE uid = ?`,
    ).run(recovery.ciphertext, recovery.iv, uid);
  }

  const response: Record<string, unknown> = {
    uid,
    name: docName,
    admin_invite: {
      token: adminInvite.token,
      url: `/d/${uid}/${adminInvite.token}`,
      display_name: adminInvite.display_name,
    },
    default_theme: theme,
    // New documents inherit the server-default renderer until the
    // owner overrides it via PATCH. Surface as null so clients can
    // tell "explicit choice" from "use server default" without an
    // extra round-trip.
    mermaid_renderer: null,
    format,
  };
  if (plaintextPassword) {
    response.password = plaintextPassword;
    c.header('Cache-Control', 'no-store');
  }
  return c.json(response, 201);
}

// --- GET /api/documents/:uid -----------------------------------------

async function getDocument(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const source = store.read(doc);
  const rendered = await renderDocument(source, doc.format);
  const attached = listAttached(db, doc.uid);
  rendered.html = await rewriteAssetReferences(rendered.html, {
    docUid: doc.uid,
    attached: new Set(attached.map((a) => a.ref_name)),
    assetVersions: new Map(attached.map((a) => [a.ref_name, a.asset_id])),
  });

  // For admin/named invites or invite sessions: the server-resolved current
  // name (invite seed on first visit, doc_users row after). For generic/no-invite:
  // null. Client uses this to keep localStorage in sync with the server.
  // `isInviteSession` covers the claim-session path (named invite was claimed
  // as a session cookie); the invite-row check covers the header token path.
  const forcedDisplayName =
    (decision.invite && decision.invite.kind !== 'generic') || decision.isInviteSession
      ? (decision.identity?.displayName ?? null)
      : null;
  return c.json({
    uid: doc.uid,
    name: doc.name,
    source,
    rendered,
    attached_assets: attached,
    format: doc.format,
    default_theme: doc.default_theme,
    mermaid_renderer: doc.mermaid_renderer,
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
  const rawCommitMessage = typeof body?.commit_message === 'string' ? body.commit_message : '';
  const commitMessage = rawCommitMessage
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 1000) || undefined;

  let previousSource = '';
  try {
    previousSource = store.read(doc);
  } catch {
    /* new doc */
  }

  const writeOptions = commitMessage ? { commitMessage } : undefined;
  const { oid } = await store.write(
    doc,
    nextSource,
    decision.identity,
    'update',
    writeOptions,
  );
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
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  const now = Date.now();
  for (const comment of topLevel) {
    const upd = reanchor(comment, rendered.blocks);
    updateStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  // Include sub-block ids so proposals on list items / table cells don't
  // get orphaned after every save. Markdown uses the mdast-based locator;
  // asciidoc hands off to its own pipeline, and its locator also emits
  // sub-block ids for supported nested structures (e.g. list items).
  const knownBlocks =
    doc.format === 'asciidoc'
      ? locateAllBlocksAsciidoc(nextSource)
      : locateAllBlocks(nextSource);
  reanchorAndBroadcast(deps, doc, knownBlocks, now, decision.identity.clientId);

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
  let refreshedSessionPersistent = true;

  // editable_by_anyone is unsettable; tolerated on incoming payloads for
  // back-compat with old clients.
  if (typeof body.default_theme === 'string') {
    updates.push(['default_theme', body.default_theme]);
  }
  // Mermaid renderer override: 'mmdr' | 'chromium' | null (null clears
  // the override, so the document falls back to the server default).
  // Anything else → 400; we don't silently coerce so an old client
  // can't unset the value by sending the wrong type.
  if ('mermaid_renderer' in body) {
    const raw = body.mermaid_renderer;
    if (raw === null) {
      updates.push(['mermaid_renderer', null]);
    } else if (isMermaidRenderer(raw)) {
      updates.push(['mermaid_renderer', raw]);
    } else {
      return c.json({ error: 'invalid-mermaid-renderer' }, 400);
    }
  }
  if (body.name === null) {
    updates.push(['name', null]);
  } else if (typeof body.name === 'string') {
    updates.push(['name', body.name.trim().slice(0, 200) || null]);
  }
  if (body.password === null) {
    updates.push(['password_hash', null]);
    updates.push(['password_recovery_ciphertext', null]);
    updates.push(['password_recovery_iv', null]);
  } else if (body.password === 'rotate') {
    if (!decision.invite || decision.invite.kind !== 'admin') {
      return c.json({ error: 'admin-token-required' }, 400);
    }
    plaintextPassword = generatePassword();
    const recovery = encryptRecoverablePassword(plaintextPassword, doc.uid, decision.invite.token);
    updates.push(['password_hash', await hashPassword(plaintextPassword)]);
    updates.push(['password_recovery_ciphertext', recovery.ciphertext]);
    updates.push(['password_recovery_iv', recovery.iv]);
    const priorToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
    const priorSession = priorToken ? readSession(db, priorToken) : null;
    refreshedSessionPersistent = priorSession?.persistent !== 0;
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
    mermaid_renderer: fresh.mermaid_renderer,
    password_protected: fresh.password_hash !== null,
  };
  if (plaintextPassword) {
    response.password = plaintextPassword;
    c.header('Cache-Control', 'no-store');
  }
  if (shouldRefreshSession) {
    // Keep the initiating admin authenticated under the newly-rotated
    // password while invalidating every previously-issued session.
    setSessionCookie(c, db, doc.uid, config.sessionTtlMs, refreshedSessionPersistent);
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
  db.prepare(
    `DELETE FROM comments_edit_proposals
      WHERE comment_id IN (SELECT id FROM comments WHERE doc_uid = ?)`,
  ).run(doc.uid);
  db.prepare('DELETE FROM comments WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM comment_mentions WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM doc_users WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM invites WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM sessions WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM document_assets WHERE doc_uid = ?').run(doc.uid);
  db.prepare('DELETE FROM documents WHERE uid = ?').run(doc.uid);

  for (const id of attachedAssetIds) {
    await gcAssetIfOrphan(db, blobs, id);
  }

  try {
    await store.destroyDocRepo(doc.uid);
  } catch {
    /* repo already gone — fine */
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

  const source = store.read(doc);
  const rendered = await renderDocument(source, doc.format);
  const comments = db
    .prepare(
      `SELECT
         c.*,
         cep.status AS proposal_status,
         cep.accepted_oid,
         cep.branch_ref,
         cep.base_oid,
         cep.base_block_start,
         cep.base_block_end
         FROM comments c
         LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
        WHERE c.doc_uid = ? AND c.deleted_at IS NULL
         ORDER BY created_at ASC`,
    )
    .all(doc.uid) as BundleCommentRow[];

  const bundle = {
    version: 4 as const,
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
      mermaid_renderer: doc.mermaid_renderer,
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
    comments: await mapBundleComments(comments, store, doc),
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
  const theme =
    typeof themeParam === 'string' && themeParam.length > 0
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

  const source = store.read(doc);
  // Title resolution for both the DOCX core properties and the
  // download filename: explicit `doc.name` wins; else the document's
  // own title (frontmatter `title:` or first H1 / `= Header`); else
  // the opaque uid. Matches what a human would expect the file to be
  // called when they open it.
  const derivedTitle = doc.name ?? extractDocumentTitle(source, doc.format);
  // Per-document renderer selection (mmdr / chromium); see
  // `apps/server/MERMAID_RENDERER.md` for the resolution order.
  // DOCX always wants PNG — Word's SVG support requires a PNG
  // fallback alongside, which doubles per-diagram cost for no clear
  // gain.
  const mermaidChoice = effectiveMermaidRenderer(doc, c);
  let mermaidEngineWarned = false;
  const onceWarn = (msg: string): void => {
    if (mermaidEngineWarned) return;
    mermaidEngineWarned = true;
    console.warn(`[docx-export] mermaid renderer (${mermaidChoice}):`, msg);
  };
  const renderMermaidPng = makeMermaidResolver(mermaidChoice, 'png', onceWarn);
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
    // Rasterize mermaid blocks via the chosen renderer so the DOCX
    // gets a real embedded image. Failures (missing binary, parse
    // error, timeout) fall back to a labeled code block — mermaid
    // in DOCX is a nice-to-have, not a hard requirement, so we
    // don't surface engine-missing as an error here (unlike PDF).
    resolveMermaid: async (source) => {
      const img = await renderMermaidPng(source);
      if (!img) return null;
      // Forward natural display dimensions (CSS px) when the
      // resolver supplied them. The chromium path renders at
      // deviceScaleFactor=4 so the PNG carries 4× more pixels than
      // the diagram's natural size; without these dims, the
      // exporter would tell Word to display at the bigger pixel
      // count and inflate the diagram 4× visually.
      const asset: { bytes: Uint8Array; mime: string; width?: number; height?: number } = {
        bytes: img.bytes,
        mime: img.mime,
      };
      if (img.naturalWidth !== undefined) asset.width = img.naturalWidth;
      if (img.naturalHeight !== undefined) asset.height = img.naturalHeight;
      return asset;
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
  // `buf` is already a Buffer (a Uint8Array view over the underlying
  // ArrayBuffer). Passing it through avoids the allocate-and-copy
  // cost of wrapping in a fresh `new Uint8Array(buf)` on every
  // export. The cast bridges a type-only mismatch: Node's Buffer
  // types as `Uint8Array<ArrayBufferLike>` (to allow a
  // SharedArrayBuffer backing in principle) while Hono insists on
  // `Uint8Array<ArrayBuffer>`. Runtime is identical — Bun's Buffer
  // is always ArrayBuffer-backed.
  return c.body(buf as unknown as Uint8Array<ArrayBuffer>);
}

// --- GET /api/documents/:uid/export.pdf ------------------------------

/**
 * PDF export. Renders the document's source to HTML via the shared
 * renderer, wraps it in a self-contained HTML envelope with the
 * selected theme + print stylesheet, and prints via headless
 * Chromium (Playwright). See `apps/server/src/export/pdf.ts` and
 * [apps/server/PDF_EXPORT.md](../../PDF_EXPORT.md) for the full
 * design and the env knobs.
 *
 * Mirrors the DOCX route's auth, theme-resolution, title-extraction,
 * and filename-derivation behavior so the two downloads produce
 * identical filenames for the same document.
 */
async function exportDocumentAsPdf(c: Context, deps: AppDeps) {
  const { db, store, blobs } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const identity = readIdentity(c.req.raw.headers);
  const themeParam = c.req.query('theme');
  const theme =
    typeof themeParam === 'string' && themeParam.length > 0
      ? themeParam
      : (doc.default_theme ?? 'default');

  const source = store.read(doc);
  // Matches DOCX: explicit `doc.name` beats the extracted title.
  const derivedTitle = doc.name ?? extractDocumentTitle(source, doc.format);

  // Render the document with the same format-agnostic entry the
  // viewer uses; mermaid stays in 'client' mode so the export page
  // can run the real mermaid runtime (see export/html-envelope.ts).
  const rendered = await renderDocument(source, doc.format, { mermaid: 'client' });

  // Build the attached-asset map once and reuse for image inlining.
  // Absolute URLs never reach the inliner — they're left alone so
  // Chromium fetches them over HTTP if reachable, or falls back to
  // alt text if not. Mirrors the DOCX resolver's scope.
  const attached = new Map<string, { assetId: string; mime: string }>();
  for (const a of listAttached(db, doc.uid)) {
    attached.set(a.ref_name, { assetId: a.asset_id, mime: a.mime });
  }
  let bodyHtml = await inlineImageAssets(rendered.html, attached, blobs);

  // Renderer dispatch:
  //   - 'mmdr'     → pre-rasterize each mermaid block to SVG out
  //                  of process and splice into the body. The PDF
  //                  Chromium then has nothing mermaid-related to
  //                  do (no UMD inline, no readiness sentinel) →
  //                  faster and smaller-bytes through `setContent`.
  //   - 'chromium' → leave the divs in place and let the in-page
  //                  mermaid runtime render them, identical to the
  //                  pre-PR21 PDF flow. We pay Chromium's cost
  //                  twice (page + mermaid runtime) but get pixel-
  //                  identical output to the viewer.
  const mermaidChoice = effectiveMermaidRenderer(doc, c);
  let mermaidEngineWarned = false;
  const onceWarn = (msg: string): void => {
    if (mermaidEngineWarned) return;
    mermaidEngineWarned = true;
    console.warn(`[pdf-export] mermaid renderer (${mermaidChoice}):`, msg);
  };
  let hasMermaidLive = rendered.mermaid.length > 0;
  if (rendered.mermaid.length > 0 && mermaidChoice === 'mmdr') {
    // SVG output for PDF (vector → vector). Failed blocks stay in
    // the body and fall through to in-page rendering as if the
    // user had picked `chromium` — but that would require the UMD
    // inline. Workaround: if ANY block fell back, keep
    // `hasMermaid: true` so the PDF page still loads the runtime
    // and finishes those leftovers. In the typical case (all
    // blocks resolved by mmdr), `hasMermaid` is false and the
    // mermaid UMD never enters the export page at all.
    const renderSvg = makeMermaidResolver(mermaidChoice, 'svg', onceWarn);
    const prerasterizer: MermaidPrerasterResolver = async (source) => {
      const img = await renderSvg(source);
      return img ? { bytes: img.bytes, mime: img.mime } : null;
    };
    const beforeLen = bodyHtml.length;
    // Bound the per-export fan-out the same way the DOCX path does
    // — each `prerasterizer` call may spawn a subprocess (mmdr) or
    // open a Chromium context (chromium), and an unbounded
    // Promise.all over a 20-diagram doc would starve the host.
    // The env knob mirrors the DOCX one for consistency.
    const concurrencyEnv = process.env.MARGINALIA_PDF_MERMAID_CONCURRENCY;
    const concurrency =
      concurrencyEnv && Number.isInteger(Number(concurrencyEnv)) && Number(concurrencyEnv) > 0
        ? Number(concurrencyEnv)
        : 4;
    bodyHtml = await prerasterizeMermaid(bodyHtml, prerasterizer, { concurrency });
    // Did we render every diagram out of process? Count blocks that
    // still need the in-page mermaid runtime — `countLiveMermaidBlocks`
    // matches on the renderer's `data-mermaid-(index|mode)` attribute,
    // not on the `mermaid` class (which the prerasterized wrapper
    // also carries for styling), so a successful pre-rasterization
    // correctly reports zero survivors and lets the envelope skip
    // the UMD.
    const survived = countLiveMermaidBlocks(bodyHtml);
    hasMermaidLive = survived > 0;
    if (process.env.MARGINALIA_DEBUG_EXPORT) {
      console.log(
        `[pdf-export] mmdr pre-rasterized: ${rendered.mermaid.length - survived}/${rendered.mermaid.length} blocks (${beforeLen} → ${bodyHtml.length} bytes, hasMermaidLive=${hasMermaidLive})`,
      );
    }
  }

  const [themeCss, printCss] = await Promise.all([loadThemeCss(theme), loadPrintCss()]);

  let buf: Uint8Array;
  try {
    buf = await exportPdf({
      body: bodyHtml,
      themeCss,
      printCss,
      meta: {
        title: derivedTitle ?? null,
        author: identity?.displayName ?? null,
        appearance: 'light',
      },
      hasMermaid: hasMermaidLive,
      // Wire the request's abort signal into the exporter so
      // Chromium work stops promptly when the client disconnects
      // (no point burning a semaphore slot to produce bytes no
      // one will read).
      signal: c.req.raw.signal,
    });
  } catch (err) {
    if (err instanceof ExportEngineMissingError) {
      return c.json(
        {
          error: err.code,
          hint: 'Run `bunx playwright install chromium-headless-shell` on the server, then retry.',
        },
        500,
      );
    }
    if (err instanceof ExportBusyError) {
      c.header('Retry-After', '2');
      return c.json({ error: err.code }, 503);
    }
    if (err instanceof ExportTimeoutError) {
      return c.json({ error: err.code, elapsed_ms: err.elapsedMs }, 504);
    }
    throw err;
  }

  const filename = sanitizeDocumentFilename(derivedTitle, doc.uid);
  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(buf as unknown as Uint8Array<ArrayBuffer>);
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
  // Mermaid renderer override: nullable, must match the typed enum
  // when present. Anything else (including legacy bundles without
  // the field) silently falls back to NULL = use server default.
  const mermaidRenderer: MermaidRenderer | null = isMermaidRenderer(docSpec.mermaid_renderer)
    ? docSpec.mermaid_renderer
    : null;
  // Bundle's editable_by_anyone is ignored; the column is deprecated.

  await store.write({ uid, format }, docSpec.source, identity, 'upload');
  db.prepare(
    `INSERT INTO documents
       (uid, repo_dir, name, password_hash, editable_by_anyone, default_theme, format, mermaid_renderer, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?)`,
  ).run(uid, uid, name, theme, format, mermaidRenderer, now, now);
  upsertDocUser(db, uid, identity);

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
  let importedEditProposals = 0;
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
       (id, doc_uid, parent_id, parent_proposal_id,
        anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
        anchor_start_offset, anchor_end_offset,
        anchor_heading_path, anchor_section_index, anchor_section_index_path,
        author_client_id, author_display_name, body, link_status,
        resolved_at, resolved_by_name,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEditProposal = db.prepare(
    `INSERT INTO comments_edit_proposals
       (comment_id, status, accepted_oid, branch_ref, base_oid, base_block_start, base_block_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Imported proposals get their branch built here from the bundle's
  // `proposed_text` rather than via the boot-time backfill (which reads
  // a column that's no longer in the schema). Single base read per doc.
  const importBaseOid = await store.mainOid({ uid, format });
  const importBaseSource = docSpec.source;
  const importBlocks =
    format === 'asciidoc'
      ? locateAllBlocksAsciidoc(importBaseSource)
      : locateAllBlocks(importBaseSource);
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
    const parentProposalOldId =
      typeof row.parent_proposal_id === 'string' ? row.parent_proposal_id : null;
    if (parentOldId && parentProposalOldId) continue;
    const isRootComment = !parentOldId && !parentProposalOldId;
    const newParentId = parentOldId ? (idMap.get(parentOldId) ?? null) : null;
    const newParentProposalId = parentProposalOldId
      ? (idMap.get(parentProposalOldId) ?? null)
      : null;
    insertComment.run(
      newId,
      uid,
      newParentId,
      newParentProposalId,
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
      normalizeImportedLinkStatus(
        typeof row.link_status === 'string'
          ? row.link_status
          : typeof row.status === 'string'
            ? row.status
            : null,
      ),
      typeof row.resolved_at === 'number' ? row.resolved_at : null,
      typeof row.resolved_by_name === 'string' ? row.resolved_by_name : null,
      typeof row.created_at === 'number' ? row.created_at : now,
      typeof row.updated_at === 'number' ? row.updated_at : now,
    );
    importedComments += 1;

    const proposal =
      row.edit_proposal && typeof row.edit_proposal === 'object'
        ? (row.edit_proposal as Record<string, unknown>)
        : null;
    if (isRootComment && proposal && typeof proposal.proposed_text === 'string') {
      const status = normalizeImportedProposalStatus(
        typeof proposal.status === 'string' ? proposal.status : null,
      );
      const acceptedOid =
        typeof proposal.accepted_oid === 'string' ? proposal.accepted_oid : null;

      // Accepted proposals: skip branch creation. The bundle's source
      // is post-accept, so splicing `proposed_text` into it would
      // produce a no-op branch (tip == base). Insert as a historical
      // row with null branch metadata; the diff endpoint returns
      // unavailable, matching the issue's "default null + block reopen
      // for pre-migration rows" stance.
      if (status === 'accepted') {
        insertEditProposal.run(newId, status, acceptedOid, null, null, null, null);
        importedEditProposals += 1;
        continue;
      }

      // Open and rejected proposals: branch creation is mandatory.
      // Without a branch the row is permanently undiffable + un-
      // acceptable (Phase 3 dropped the column fallback). Skip the
      // proposal row on failure rather than insert a broken one.
      const anchorBlockId = typeof row.anchor_block_id === 'string' ? row.anchor_block_id : null;
      const range = anchorBlockId ? importBlocks.get(anchorBlockId) : undefined;
      if (!range) {
        console.warn(
          `[marginalia] import skipped proposal ${newId} (${uid}): anchor block not found in source`,
        );
        continue;
      }
      const nextSource =
        importBaseSource.slice(0, range.start) +
        proposal.proposed_text +
        importBaseSource.slice(range.end);
      try {
        const result = await store.createProposalBranch(
          { uid, format },
          importBaseOid,
          newId,
          nextSource,
          { clientId: row.author_client_id, displayName: row.author_display_name },
          typeof row.body === 'string' ? row.body : null,
        );
        insertEditProposal.run(
          newId,
          status,
          acceptedOid,
          result.refName,
          importBaseOid,
          range.start,
          range.end,
        );
        importedEditProposals += 1;
      } catch (err) {
        console.warn(
          `[marginalia] import skipped proposal ${newId} (${uid}): branch creation failed:`,
          err,
        );
      }
    }
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
      imported_edit_proposals: importedEditProposals,
    },
    201,
  );
}

function isBundleVersion(v: unknown): v is 1 | 2 | 3 | 4 {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

function reanchorAndBroadcast(
  deps: AppDeps,
  doc: DocumentRow,
  blocks: Map<string, BlockSourceRange>,
  now: number,
  exceptClientId: string,
): void {
  const orphaned = reanchorProposals(deps.db, doc.uid, blocks, doc.format, now);
  for (const row of orphaned) {
    deps.realtime.broadcast(
      doc.uid,
      {
        type: 'edit_proposal.updated',
        edit_proposal: toEditProposalWire(row),
      },
      exceptClientId,
    );
  }
}

/**
 * Sequential `for...of` rather than `Promise.all`: each branch-backed
 * proposal does git reads, and a doc with hundreds of proposals would
 * otherwise spike open-fd / I/O contention by reading them all at once.
 */
async function mapBundleComments(
  comments: BundleCommentRow[],
  store: GitStore,
  doc: DocumentRow,
): Promise<unknown[]> {
  return mapWithConcurrency(comments, 4, async (row) => ({
    id: row.id,
    parent_id: row.parent_id,
    parent_proposal_id: row.parent_proposal_id,
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
    link_status: row.link_status,
    resolved_at: row.resolved_at,
    resolved_by_name: row.resolved_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    edit_proposal: await bundleProposalPayload(store, doc, row),
  }));
}

async function bundleProposalPayload(
  store: GitStore,
  doc: DocumentRow,
  row: BundleCommentRow,
): Promise<{
  source_snapshot: string;
  proposed_text: string;
  status: EditProposalStatus;
  accepted_oid: string | null;
} | null> {
  if (row.proposal_status === null) return null;
  const content = await readProposalContent(store, doc, row);
  if (content) {
    return {
      source_snapshot: content.source_snapshot,
      proposed_text: content.proposed_text,
      status: row.proposal_status,
      accepted_oid: row.accepted_oid,
    };
  }
  // Historical row without recoverable content (legacy accepted, or
  // an import that landed without a branch). Preserve status +
  // accepted_oid so a round-trip doesn't drop the proposal record;
  // empty placeholders keep the bundle schema stable. Open and
  // rejected rows without a branch can't be safely reconstructed
  // (no diff content to splice on re-import) so they're dropped.
  if (row.proposal_status !== 'accepted') return null;
  return {
    source_snapshot: '',
    proposed_text: '',
    status: row.proposal_status,
    accepted_oid: row.accepted_oid,
  };
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

function normalizeImportedLinkStatus(raw: string | null): 'linked' | 'low-confidence' | 'orphaned' {
  if (raw === 'low-confidence' || raw === 'orphaned') return raw;
  return 'linked';
}

function normalizeImportedProposalStatus(raw: string | null): EditProposalStatus {
  if (raw === 'accepted' || raw === 'rejected') return raw;
  return 'open';
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

  const userNames = listDocUserNameMap(db, doc.uid);
  const entries = await store.history(doc);
  // Per-entry mapping does git reads only for `accept-proposal` entries
  // (loadAcceptedProposalHistory may read base + tip blobs). Run with a
  // small concurrency cap so `/history` doesn't get linear-in-history
  // latency, but doesn't open unbounded fds either.
  const history = await mapWithConcurrency(entries, 4, (entry) =>
    toHistoryWire(db, store, doc, entry, userNames),
  );
  return c.json({ history });
}

async function getHistoryDiff(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);
  const oid = c.req.param('oid');
  if (!oid) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const diff = await store.diffAt(doc, oid);
  if (!diff) return c.json({ error: 'not-found' }, 404);
  return c.json(diff);
}

async function restoreHistoryVersion(c: Context, deps: AppDeps) {
  const { db, store, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);
  const targetOid = c.req.param('oid');
  if (!targetOid) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  let restoredSource: string;
  try {
    restoredSource = await store.readAt(doc, targetOid);
  } catch {
    return c.json({ error: 'not-found' }, 404);
  }

  const { oid } = await store.write(
    doc,
    restoredSource,
    decision.identity,
    'restore',
    {
      restoredFromOid: targetOid,
    },
  );
  const now = Date.now();
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

  const rendered = await renderDocument(restoredSource, doc.format);
  const topLevel = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const updateStmt = db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevel) {
    const upd = reanchor(comment, rendered.blocks);
    updateStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  const knownBlocks =
    doc.format === 'asciidoc'
      ? locateAllBlocksAsciidoc(restoredSource)
      : locateAllBlocks(restoredSource);
  reanchorAndBroadcast(deps, doc, knownBlocks, now, decision.identity.clientId);

  realtime.broadcast(
    doc.uid,
    { type: 'document.updated', oid, author: decision.identity.displayName },
    decision.identity.clientId,
  );

  return c.json({ oid });
}

async function revertLatestHistoryVersion(c: Context, deps: AppDeps) {
  const { db, store, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);
  const targetOid = c.req.param('oid');
  if (!targetOid) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const history = await store.history(doc);
  const latest = history[0];
  const parent = history[1];
  if (!latest || latest.oid !== targetOid) return c.json({ error: 'not-latest' }, 409);
  if (!parent) return c.json({ error: 'no-parent' }, 409);

  const diff = await store.diffAt(doc, targetOid);
  if (!diff) return c.json({ error: 'not-found' }, 404);

  const meta = parseHistoryMetadata(latest);
  const { oid } = await store.write(
    doc,
    diff.before,
    decision.identity,
    'restore',
    {
      restoredFromOid: parent.oid,
    },
  );
  const now = Date.now();
  db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

  const rendered = await renderDocument(diff.before, doc.format);
  const topLevel = db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const updateStmt = db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevel) {
    const upd = reanchor(comment, rendered.blocks);
    updateStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  const reopenedProposalId =
    meta.action === 'accept-proposal' && meta.proposalId
      ? (reopenAcceptedProposal(db, doc.uid, meta.proposalId, now)?.id ?? null)
      : null;

  const knownBlocks =
    doc.format === 'asciidoc'
      ? locateAllBlocksAsciidoc(diff.before)
      : locateAllBlocks(diff.before);
  reanchorAndBroadcast(deps, doc, knownBlocks, now, decision.identity.clientId);

  if (reopenedProposalId) {
    const reopened = loadProposalRow(db, reopenedProposalId, doc.uid);
    if (reopened && reopened.proposal_status === 'open') {
      realtime.broadcast(
        doc.uid,
        {
          type: 'edit_proposal.updated',
          edit_proposal: toEditProposalWire(reopened),
        },
        decision.identity.clientId,
      );
    }
  }

  realtime.broadcast(
    doc.uid,
    { type: 'document.updated', oid, author: decision.identity.displayName },
    decision.identity.clientId,
  );

  return c.json({ oid, reopened_proposal_id: reopenedProposalId });
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
  const remember = body.remember !== false;

  const ok = await verifyPassword(body.password, doc.password_hash);
  if (!ok) return c.json({ error: 'wrong-password' }, 401);

  setSessionCookie(c, db, doc.uid, config.sessionTtlMs, remember);
  return c.body(null, 204);
}

async function logout(c: Context, deps: AppDeps) {
  const doc = loadDoc(deps.db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const token = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
  if (token) deleteSession(deps.db, token);
  clearSessionCookie(c);
  return c.body(null, 204);
}

async function recoverCurrentPassword(c: Context, deps: AppDeps) {
  const doc = loadDoc(deps.db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);
  if (doc.password_hash === null) {
    return c.json({ error: 'not-password-protected' }, 400);
  }

  const invite = requireAdminInvite(c, deps.db, doc.uid);
  if (!invite) return c.json({ error: 'forbidden' }, 403);
  if (!doc.password_recovery_ciphertext || !doc.password_recovery_iv) {
    return c.json({ error: 'password-unavailable' }, 409);
  }

  try {
    const password = decryptRecoverablePassword(doc, invite.token);
    c.header('Cache-Control', 'no-store');
    return c.json({ password });
  } catch {
    return c.json({ error: 'password-recovery-failed' }, 500);
  }
}

function setSessionCookie(
  c: Context,
  db: Database,
  docUid: string,
  ttlMs: number,
  persistent = true,
): void {
  const token = createSession(db, docUid, ttlMs, persistent);
  const maxAge = Math.floor(ttlMs / 1000);
  const persistencePart = persistent ? `; Max-Age=${maxAge}` : '';
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${persistencePart}`,
  );
}

function clearSessionCookie(c: Context): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
 * Claim a named (or generic) invite: mint an invite session cookie so the
 * browser no longer needs the token in the URL. The invite row is kept so
 * the same user can claim again from a different browser. Admin invites and
 * password-protected docs are excluded — they use separate mechanisms.
 */
async function claimInvite(c: Context, deps: AppDeps) {
  const { db, config } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  // Password-protected docs: the password gate would reject an invite session
  // anyway, so claiming doesn't help. The invite-header flow still works.
  if (doc.password_hash !== null) {
    return c.json({ error: 'password-protected' }, 409);
  }

  const token = c.req.param('token');
  if (!token) return c.json({ error: 'not-found' }, 404);

  const invite = db
    .prepare('SELECT * FROM invites WHERE token = ? AND doc_uid = ?')
    .get(token, doc.uid) as InviteRow | undefined;
  if (!invite) return c.json({ error: 'not-found' }, 404);

  // Admin invites stay permanent and use rotate-on-leak, not claiming.
  if (invite.kind === 'admin') {
    return c.json({ error: 'admin-invite-not-claimable' }, 400);
  }

  // Mint an invite session. The invite row is NOT deleted so the user can
  // re-claim from another browser using the original URL.
  const sessionToken = createSession(db, doc.uid, config.namedInviteSessionTtlMs, true, {
    display_name: invite.display_name,
    role: invite.role,
    kind: invite.kind,
  });
  const maxAge = Math.floor(config.namedInviteSessionTtlMs / 1000);
  c.header(
    'Set-Cookie',
    `${INVITE_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
  return c.json({ display_name: invite.display_name, role: invite.role }, 201);
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
  const recoverablePassword =
    decision.invite &&
    doc.password_recovery_ciphertext &&
    doc.password_recovery_iv &&
    decision.invite.kind === 'admin'
      ? decryptRecoverablePassword(doc, decision.invite.token)
      : null;
  // Insert-then-delete so the doc is never admin-less between steps.
  const fresh = createInviteRow(db, {
    docUid: doc.uid,
    // Carry the admin's CURRENT identity forward so a local rename is
    // reflected in the rotated link immediately.
    displayName: decision.identity.displayName,
    role: 'admin',
    kind: 'admin',
    note: existing?.note ?? 'Author',
    createdByName: decision.identity.displayName,
  });
  if (recoverablePassword !== null) {
    const recovery = encryptRecoverablePassword(recoverablePassword, doc.uid, fresh.token);
    db.prepare(
      `UPDATE documents
          SET password_recovery_ciphertext = ?, password_recovery_iv = ?
        WHERE uid = ?`,
    ).run(recovery.ciphertext, recovery.iv, doc.uid);
  }
  db.prepare(`DELETE FROM invites WHERE doc_uid = ? AND kind = 'admin' AND token != ?`).run(
    doc.uid,
    fresh.token,
  );
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

type HistoryAction = 'upload' | 'update' | 'restore' | 'accept-proposal' | 'unknown';

interface AcceptedProposalHistoryRow {
  id: string;
  rationale: string | null;
  author_client_id: string;
  author_display_name: string;
  branch_ref: string | null;
  base_oid: string | null;
  base_block_start: number | null;
  base_block_end: number | null;
}

async function toHistoryWire(
  db: Database,
  store: GitStore,
  doc: DocumentRow,
  entry: GitHistoryEntry,
  userNames: Map<string, string>,
): Promise<Record<string, unknown>> {
  const meta = parseHistoryMetadata(entry);
  const actorDisplayName = meta.clientId
    ? (userNames.get(meta.clientId) ?? fallbackHistoryAuthorName(entry.author.name, meta.clientId))
    : fallbackHistoryAuthorName(entry.author.name, null);
  const proposal =
    meta.action === 'accept-proposal'
      ? await loadAcceptedProposalHistory(db, store, doc, entry.oid, userNames, meta.proposalId)
      : null;

  return {
    oid: entry.oid,
    action: meta.action,
    actor: {
      client_id: meta.clientId,
      display_name: actorDisplayName,
    },
    timestamp: entry.timestamp,
    restored_from_oid: meta.restoredFromOid,
    proposal,
  };
}

function parseHistoryMetadata(entry: GitHistoryEntry): {
  action: HistoryAction;
  clientId: string | null;
  proposalId: string | null;
  restoredFromOid: string | null;
} {
  const firstLine = entry.message.split('\n', 1)[0]?.trim() ?? '';
  const action = parseHistoryAction(firstLine);
  const trailerClientId = readCommitTrailer(entry.message, 'X-Marginalia-Client-ID');
  const emailClientId = extractClientIdFromEmail(entry.author.email);
  const proposalId =
    readCommitTrailer(entry.message, 'X-Marginalia-Proposal-ID') ??
    extractHistorySubjectValue(firstLine, 'accept-proposal:');

  return {
    action,
    clientId: trailerClientId ?? emailClientId,
    proposalId,
    restoredFromOid: readCommitTrailer(entry.message, 'X-Marginalia-Restored-From'),
  };
}

function parseHistoryAction(firstLine: string): HistoryAction {
  if (firstLine.startsWith('upload:')) return 'upload';
  if (firstLine.startsWith('update:')) return 'update';
  if (firstLine.startsWith('restore:')) return 'restore';
  if (firstLine.startsWith('accept-proposal:')) return 'accept-proposal';
  return 'unknown';
}

function readCommitTrailer(message: string, key: string): string | null {
  const needle = `${key}:`;
  for (const rawLine of message.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(needle)) continue;
    const value = line.slice(needle.length).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function extractHistorySubjectValue(firstLine: string, prefix: string): string | null {
  if (!firstLine.startsWith(prefix)) return null;
  const value = firstLine.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function extractClientIdFromEmail(email: string): string | null {
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at).trim();
  return local.length > 0 ? local : null;
}

function fallbackHistoryAuthorName(authorName: string, clientId: string | null): string | null {
  const trimmed = authorName.trim();
  if (!trimmed) return null;
  if (clientId && trimmed === clientId) return null;
  return trimmed;
}

async function loadAcceptedProposalHistory(
  db: Database,
  store: GitStore,
  doc: DocumentRow,
  acceptedOid: string,
  userNames: Map<string, string>,
  proposalId: string | null,
): Promise<Record<string, unknown> | null> {
  const select = `
    SELECT
      c.id,
      NULLIF(c.body, '') AS rationale,
      c.author_client_id,
      c.author_display_name,
      cep.branch_ref,
      cep.base_oid,
      cep.base_block_start,
      cep.base_block_end
    FROM comments c
    INNER JOIN comments_edit_proposals cep ON cep.comment_id = c.id
    WHERE c.doc_uid = ?
      AND c.deleted_at IS NULL
  `;
  const row = (
    proposalId
      ? db.prepare(`${select} AND c.id = ? LIMIT 1`).get(doc.uid, proposalId)
      : db.prepare(`${select} AND cep.accepted_oid = ? LIMIT 1`).get(doc.uid, acceptedOid)
  ) as AcceptedProposalHistoryRow | null | undefined;
  if (!row) return null;

  // Skip the git read when rationale is non-empty — summarize prefers
  // it and proposedText is only the fallback.
  const proposedText = row.rationale?.trim()
    ? null
    : await readProposedTextFromBranch(store, doc, row);
  return {
    id: row.id,
    author: {
      client_id: row.author_client_id,
      display_name: userNames.get(row.author_client_id) ?? row.author_display_name,
    },
    summary: summarizeProposalHistory(row.rationale, proposedText),
  };
}

async function readProposedTextFromBranch(
  store: GitStore,
  doc: DocumentRow,
  row: AcceptedProposalHistoryRow,
): Promise<string | null> {
  return (await readProposalContent(store, doc, row))?.proposed_text ?? null;
}

function summarizeProposalHistory(rationale: string | null, proposedText: string | null): string {
  const trimmed = rationale?.trim();
  if (trimmed) return clipHistoryText(trimmed, 160);
  if (!proposedText) return '(proposal)';
  const firstLine =
    proposedText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? proposedText.trim();
  return clipHistoryText(firstLine || '(empty proposal)', 160);
}

function clipHistoryText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function loadDoc(db: Database, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}

function authorizeRequest(c: Context, deps: AppDeps, doc: DocumentRow) {
  const cookie = c.req.raw.headers.get('cookie');
  const sessionToken = parseCookie(cookie, SESSION_COOKIE);
  const inviteSessionToken = parseCookie(cookie, INVITE_SESSION_COOKIE);
  return authorize(deps.db, doc, c.req.raw.headers, sessionToken, inviteSessionToken);
}

function requireAdminInvite(c: Context, db: Database, docUid: string): InviteRow | null {
  const invite = readInvite(db, c.req.raw.headers, docUid);
  if (!invite || invite.kind !== 'admin' || invite.role !== 'admin') return null;
  return invite;
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

function encryptRecoverablePassword(
  plain: string,
  docUid: string,
  adminToken: string,
): { ciphertext: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', passwordRecoveryKey(docUid, adminToken), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return {
    ciphertext: payload.toString('base64'),
    iv: iv.toString('base64'),
  };
}

function decryptRecoverablePassword(doc: DocumentRow, adminToken: string): string {
  if (!doc.password_recovery_ciphertext || !doc.password_recovery_iv) {
    throw new Error('password-unavailable');
  }
  const payload = Buffer.from(doc.password_recovery_ciphertext, 'base64');
  if (payload.length < 17) throw new Error('password-recovery-payload-too-short');
  const iv = Buffer.from(doc.password_recovery_iv, 'base64');
  const ciphertext = payload.subarray(0, -16);
  const authTag = payload.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', passwordRecoveryKey(doc.uid, adminToken), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function passwordRecoveryKey(docUid: string, adminToken: string): Buffer {
  return createHash('sha256')
    .update('marginalia-password-recovery\0')
    .update(docUid)
    .update('\0')
    .update(adminToken)
    .digest();
}
