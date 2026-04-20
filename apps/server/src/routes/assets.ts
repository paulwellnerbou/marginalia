import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { SESSION_COOKIE, authorize, canEdit, parseCookie } from '../auth.js';
import type { BlobStore } from '../blob-store.js';
import type { ServerConfig } from '../config.js';
import type { AssetKind, AssetRow, DocumentAssetRow, DocumentRow } from '../db.js';
import { isAssetKind } from '../db.js';

export interface AssetsDeps {
  db: Database;
  blobs: BlobStore;
  config: ServerConfig;
}

export function assetsRouter(deps: AssetsDeps): Hono {
  const r = new Hono();

  r.get('/:uid/assets', async (c) => listAssets(c, deps));
  r.post('/:uid/assets', async (c) => uploadAsset(c, deps));
  // Ref names can contain dots and slashes; Hono's default param matcher
  // chokes on those, so capture the rest of the path ourselves.
  r.get('/:uid/assets/:refName{.+}', async (c) => fetchAsset(c, deps));
  r.delete('/:uid/assets/:refName{.+}', async (c) => deleteAsset(c, deps));

  return r;
}

async function listAssets(c: Context, { db }: AssetsDeps) {
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeDoc(c, db, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  return c.json({ assets: listAttached(db, doc.uid) });
}

async function uploadAsset(c: Context, { db, blobs, config }: AssetsDeps) {
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeDoc(c, db, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.json({ error: 'invalid-form' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'file-required' }, 400);

  const refNameRaw = form.get('ref_name');
  const refName = typeof refNameRaw === 'string' ? normalizeRefName(refNameRaw) : null;
  if (!refName) return c.json({ error: 'ref_name-required' }, 400);

  if (file.size > config.maxAssetBytes) {
    return c.json({ error: 'file-too-large', limit: config.maxAssetBytes }, 413);
  }

  const kindHint = form.get('kind');
  const kind: AssetKind = isAssetKind(kindHint)
    ? kindHint
    : inferKind(file.type, refName);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const assetId = await blobs.put(bytes);
  // Derive the served Content-Type from the ref_name extension only —
  // never from `file.type`. Stored on the per-document junction row
  // rather than on the globally-shared `assets` row: blobs are
  // content-addressed, so writing mime to `assets` would let the first
  // uploader of a given sha256 control how the bytes are served to
  // every later attachment of the same bytes under a different
  // extension.
  const mime = inferMime(refName);
  const now = Date.now();

  // `assets.mime` is legacy — the authoritative Content-Type now lives
  // on the per-document junction row. We still populate it on insert
  // because the column is NOT NULL and the data is harmless to keep.
  // A future migration can drop the column once nothing reads it.
  db.prepare(
    `INSERT OR IGNORE INTO assets (id, mime, size, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(assetId, mime, file.size, now);

  // Capture the prior asset_id (if any) so we can GC the old blob after
  // the row flips to the new one. A second upload with the same ref_name
  // replaces the attachment in place.
  const prior = db
    .prepare(
      'SELECT asset_id FROM document_assets WHERE doc_uid = ? AND ref_name = ?',
    )
    .get(doc.uid, refName) as { asset_id: string } | undefined;

  db.prepare(
    `INSERT INTO document_assets
       (doc_uid, ref_name, asset_id, kind, mime, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_uid, ref_name) DO UPDATE SET
       asset_id = excluded.asset_id,
       kind = excluded.kind,
       mime = excluded.mime,
       created_at = excluded.created_at,
       created_by = excluded.created_by`,
  ).run(doc.uid, refName, assetId, kind, mime, now, decision.identity.displayName);

  if (prior && prior.asset_id !== assetId) {
    await gcAssetIfOrphan(db, blobs, prior.asset_id);
  }

  const row = loadAttached(db, doc.uid, refName);
  return c.json({ asset: row }, 201);
}

async function fetchAsset(c: Context, { db, blobs }: AssetsDeps) {
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeDoc(c, db, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const refName = decodeRefName(c.req.param('refName'));
  if (!refName) return c.json({ error: 'not-found' }, 404);

  const row = db
    .prepare(
      `SELECT da.ref_name, da.asset_id, da.kind, da.mime, a.size
         FROM document_assets da
         JOIN assets a ON a.id = da.asset_id
         WHERE da.doc_uid = ? AND da.ref_name = ?`,
    )
    .get(doc.uid, refName) as
    | { ref_name: string; asset_id: string; kind: AssetKind; mime: string; size: number }
    | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);

  // `max-age=0, must-revalidate` forces the browser to re-issue a
  // conditional request on every access. authz runs before we answer
  // 304, so a user whose invite was revoked (or whose session expired
  // for a password-protected doc) can't keep viewing a cached asset.
  // The ETag still lets the server skip re-streaming the bytes when
  // access is still valid — content is sha256-addressed so the ETag
  // only changes when the bytes change.
  const cacheControl = 'private, max-age=0, must-revalidate';
  const etag = `"${row.asset_id}"`;
  // `nosniff` stops the browser from guessing a more permissive type
  // (e.g. executing `application/octet-stream` as JavaScript because
  // the bytes start with `<script>`). Combined with attachment
  // disposition for non-image mimes, this closes the usual
  // user-upload-served-same-origin XSS paths.
  const commonHeaders: Record<string, string> = {
    ETag: etag,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  };
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    return c.body(null, 304, commonHeaders);
  }

  let bytes: Uint8Array;
  try {
    bytes = await blobs.get(row.asset_id);
  } catch {
    return c.json({ error: 'blob-missing' }, 500);
  }

  // Response accepts Uint8Array directly; no need to unwrap to ArrayBuffer
  // (and `bytes.buffer` might be SharedArrayBuffer, which Response doesn't
  // take). The body encoder will copy the view's byte range.
  const headers: Record<string, string> = {
    ...commonHeaders,
    'Content-Type': row.mime,
    'Content-Length': String(row.size),
  };
  // Only raster image types get rendered inline. SVG is deliberately
  // excluded (can embed scripts that execute when opened standalone),
  // as is anything non-image. Attachment disposition means a direct
  // visit to the asset URL downloads rather than executes.
  if (!INLINE_SAFE_MIMES.has(row.mime)) {
    headers['Content-Disposition'] = 'attachment';
  }
  return new Response(bytes as BodyInit, { status: 200, headers });
}

const INLINE_SAFE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

async function deleteAsset(c: Context, { db, blobs }: AssetsDeps) {
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeDoc(c, db, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  // Match the rest of the write path: identity is required before we
  // touch any table. Generic invites that don't supply a header-backed
  // name can't delete — same gate as updateDocument + uploadAsset, so
  // audit logs stay attributable.
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const refName = decodeRefName(c.req.param('refName'));
  if (!refName) return c.json({ error: 'not-found' }, 404);

  const row = db
    .prepare(
      'SELECT asset_id FROM document_assets WHERE doc_uid = ? AND ref_name = ?',
    )
    .get(doc.uid, refName) as { asset_id: string } | undefined;
  if (!row) return c.json({ error: 'not-found' }, 404);

  db.prepare(
    'DELETE FROM document_assets WHERE doc_uid = ? AND ref_name = ?',
  ).run(doc.uid, refName);
  await gcAssetIfOrphan(db, blobs, row.asset_id);
  return c.body(null, 204);
}

/**
 * Remove the blob and `assets` row for `assetId` if no document still
 * references it. Safe to call after any detach (upload-replace, delete,
 * document delete cascade). Best-effort: if the blob delete fails (e.g.
 * transient S3 hiccup) the DB still gets cleaned — the orphan-blob
 * question is independent from the junction table invariant.
 */
export async function gcAssetIfOrphan(
  db: Database,
  blobs: BlobStore,
  assetId: string,
): Promise<void> {
  const row = db
    .prepare('SELECT 1 AS present FROM document_assets WHERE asset_id = ? LIMIT 1')
    .get(assetId) as { present: number } | undefined;
  if (row) return;
  db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
  try {
    await blobs.delete(assetId);
  } catch {
    // Leaving an orphan blob behind is preferable to erroring out a
    // user-facing request. A batch sweeper could pick these up later.
  }
}

export interface AttachedAsset {
  ref_name: string;
  asset_id: string;
  kind: AssetKind;
  mime: string;
  size: number;
  created_at: number;
  created_by: string;
}

export function listAttached(db: Database, docUid: string): AttachedAsset[] {
  return db
    .prepare(
      `SELECT da.ref_name, da.asset_id, da.kind, da.mime, da.created_at,
              da.created_by, a.size
         FROM document_assets da
         JOIN assets a ON a.id = da.asset_id
         WHERE da.doc_uid = ?
         ORDER BY da.ref_name ASC`,
    )
    .all(docUid) as AttachedAsset[];
}

function loadAttached(db: Database, docUid: string, refName: string): AttachedAsset | null {
  return (
    (db
      .prepare(
        `SELECT da.ref_name, da.asset_id, da.kind, da.mime, da.created_at,
                da.created_by, a.size
           FROM document_assets da
           JOIN assets a ON a.id = da.asset_id
           WHERE da.doc_uid = ? AND da.ref_name = ?`,
      )
      .get(docUid, refName) as AttachedAsset | undefined) ?? null
  );
}

function loadDoc(db: Database, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}

function authorizeDoc(c: Context, db: Database, doc: DocumentRow) {
  const sessionToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
  return authorize(db, doc, c.req.raw.headers, sessionToken);
}

function normalizeRefName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  // Reject path traversal + URL-reserved delimiters. Clients reference
  // assets the same way they appeared in the source document
  // ("diagram.png", "images/foo.png"). Leading slashes, backslashes,
  // and dot segments are either confused or hostile; `?` / `#` cannot
  // round-trip through `/assets/:refName` (the browser would treat
  // them as query/fragment, so the accepted name would become
  // un-fetchable afterwards).
  if (trimmed.startsWith('/') || trimmed.includes('\\')) return null;
  if (trimmed.includes('?') || trimmed.includes('#')) return null;
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return trimmed;
}

function decodeRefName(raw: string | undefined): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return normalizeRefName(decoded);
}

function inferKind(mime: string, refName: string): AssetKind {
  if (mime.startsWith('image/')) return 'image';
  if (/\.(adoc|asciidoc|md|markdown|txt)$/i.test(refName)) return 'include';
  if (mime.startsWith('text/')) return 'include';
  return 'attachment';
}

/** Very small mime fallback — only used when the browser didn't send one. */
function inferMime(refName: string): string {
  const ext = refName.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'adoc':
    case 'asciidoc':
      return 'text/asciidoc';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

// Re-export types kept internal for the router.
export type { AssetRow, DocumentAssetRow };
