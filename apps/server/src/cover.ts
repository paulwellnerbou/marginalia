import type { Database } from 'bun:sqlite';
import type { BlobStore } from './blob-store.js';
import type { DocumentRow } from './db.js';

/**
 * A document's book cover. Stored like any other document asset — a
 * content-addressed blob plus a `document_assets` row — with
 * `documents.cover_ref` naming the row. That buys the cover the same
 * per-document authorization, ETag revalidation and blob GC every other
 * asset gets, and makes it fetchable through the ordinary asset proxy so
 * the viewer and the document list can render it as an image.
 */
export interface StoredCover {
  bytes: Uint8Array;
  mime: CoverMime;
}

export type CoverMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Cap covers well below the generic asset limit. A cover is one
 * full-page image; anything larger is a mistake that would bloat every
 * EPUB built from the document.
 */
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

/** Reserved ref name for the cover, keyed by format so the served
 *  Content-Type (derived from the extension) matches the bytes. */
export function coverRefName(mime: CoverMime): string {
  return `cover.${COVER_EXTENSIONS[mime]}`;
}

const COVER_EXTENSIONS: Record<CoverMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Narrow a stored mime string to a format the exporter can carry.
 * `Object.hasOwn` rather than `in`: the latter walks the prototype
 * chain, so `'toString'` would pass and reach the EPUB manifest as a
 * media type.
 */
export function isCoverMime(value: string): value is CoverMime {
  return Object.hasOwn(COVER_EXTENSIONS, value);
}

/**
 * Identify a cover image from its magic bytes. Deliberately ignores the
 * client-declared MIME type: the value ends up in the EPUB manifest and
 * in the asset proxy's Content-Type, so it has to describe the actual
 * bytes. SVG is excluded — it can carry script, and readers vary wildly
 * in how they sandbox it.
 */
export function sniffCoverMime(bytes: Uint8Array): CoverMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/))
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export interface CoverDescriptor {
  ref_name: string;
  asset_id: string;
  mime: string;
}

/**
 * The cover's identity — enough for a client to build the asset proxy
 * URL, without reading the blob. `cover_ref` can outlive the asset row
 * if the asset was detached through the generic asset routes, so the
 * join result (not the column) is the source of truth.
 */
export function loadCoverDescriptor(db: Database, doc: DocumentRow): CoverDescriptor | null {
  if (!doc.cover_ref) return null;
  const row = db
    .prepare(
      `SELECT da.ref_name, da.asset_id, da.mime
         FROM document_assets da
         WHERE da.doc_uid = ? AND da.ref_name = ?`,
    )
    .get(doc.uid, doc.cover_ref) as CoverDescriptor | undefined;
  return row ?? null;
}

/** Read the stored cover's bytes for embedding into an export. */
export async function loadStoredCover(
  db: Database,
  blobs: BlobStore,
  doc: DocumentRow,
): Promise<StoredCover | null> {
  const descriptor = loadCoverDescriptor(db, doc);
  if (!descriptor) return null;
  if (!isCoverMime(descriptor.mime)) return null;
  const mime = descriptor.mime;
  try {
    return { bytes: await blobs.get(descriptor.asset_id), mime };
  } catch {
    // A missing blob must not fail the export — the exporter falls back
    // to its generated title cover.
    return null;
  }
}
