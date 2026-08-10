import type { Database } from 'bun:sqlite';
import sharp from 'sharp';
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

/**
 * Internal document-asset ref used for the small image shown in cover
 * pickers and on the landing page. It deliberately does not depend on
 * the source format: every upload is flattened to WebP, so clients can
 * keep one stable URL shape while the original remains untouched for
 * EPUB export.
 */
export const COVER_THUMBNAIL_REF = '__marginalia-cover-thumbnail.webp';
export const COVER_THUMBNAIL_MIME = 'image/webp';

/** 192 CSS px covers the 72 px dialog preview even on dense displays. */
export const COVER_THUMBNAIL_WIDTH = 192;
export const COVER_THUMBNAIL_HEIGHT = 288;

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
  thumbnail: CoverImageDescriptor | null;
}

export interface CoverImageDescriptor {
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
      `SELECT cover.ref_name, cover.asset_id, cover.mime,
              thumbnail.ref_name AS thumbnail_ref_name,
              thumbnail.asset_id AS thumbnail_asset_id,
              thumbnail.mime AS thumbnail_mime
         FROM document_assets cover
         LEFT JOIN document_assets thumbnail
                ON thumbnail.doc_uid = cover.doc_uid
               AND thumbnail.ref_name = ?
         WHERE cover.doc_uid = ? AND cover.ref_name = ?`,
    )
    .get(COVER_THUMBNAIL_REF, doc.uid, doc.cover_ref) as
    | (CoverImageDescriptor & {
        thumbnail_ref_name: string | null;
        thumbnail_asset_id: string | null;
        thumbnail_mime: string | null;
      })
    | undefined;
  if (!row) return null;
  return {
    ref_name: row.ref_name,
    asset_id: row.asset_id,
    mime: row.mime,
    thumbnail:
      row.thumbnail_ref_name && row.thumbnail_asset_id && row.thumbnail_mime
        ? {
            ref_name: row.thumbnail_ref_name,
            asset_id: row.thumbnail_asset_id,
            mime: row.thumbnail_mime,
          }
        : null,
  };
}

/**
 * Decode, orient, crop and compress an uploaded cover for small UI slots.
 * Running this before either blob is attached also makes the image decoder
 * the final validity check: a file with a plausible magic header but broken
 * image data never becomes the document's cover.
 */
export async function createCoverThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  const output = await sharp(bytes, { failOn: 'error', animated: false })
    .rotate()
    .resize(COVER_THUMBNAIL_WIDTH, COVER_THUMBNAIL_HEIGHT, {
      fit: 'cover',
      position: 'centre',
    })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
  return new Uint8Array(output);
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
