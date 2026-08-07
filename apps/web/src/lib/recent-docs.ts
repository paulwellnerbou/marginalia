/**
 * Tracks every document the current user has opened, in localStorage.
 *
 * Used by the landing page (to render "Recent documents"), and by the
 * ViewPage on mount to record the last-seen time — this lets us surface
 * "new since X" indicators later.
 */

import type { DocumentCover, DocumentFormat, KeyringDocEntry } from './api.js';

const KEY = 'marginalia.recentDocs';
const MAX = 50;

export interface RecentDoc {
  uid: string;
  title: string;
  role: 'admin' | 'editor' | 'collaborator' | 'reader';
  password_protected: boolean;
  /** Source flavour of the doc. Legacy entries (pre-AsciiDoc support)
   *  default to 'markdown' on read. */
  format: DocumentFormat;
  /** When we last opened it. */
  visited_at: number;
  /** When the doc was last updated on the server (as reported by GET). */
  updated_at: number;
  /** Invite token used to open this doc (undefined for public-only access). */
  invite_token?: string;
  /**
   * Book cover as of the last visit, so the card can render a thumbnail
   * without the landing page having to call the server for every entry.
   * A cover added from another browser only shows up here after the next
   * visit; a stale one 404s and the card falls back to no thumbnail.
   */
  cover?: DocumentCover;
}

/** Build the URL we should navigate to when re-opening a recent doc. */
export function openUrlFor(doc: RecentDoc): string {
  return doc.invite_token ? `/d/${doc.uid}/${doc.invite_token}` : `/d/${doc.uid}`;
}

export function loadRecentDocs(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(coerceRecentDoc);
  } catch {
    return [];
  }
}

export function recordVisit(doc: RecentDoc): void {
  const list = loadRecentDocs().filter((d) => d.uid !== doc.uid);
  list.unshift(doc);
  const trimmed = list.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded — best-effort */
  }
}

/**
 * Patch the cover on an already-recorded entry. Called right after a
 * cover upload/removal so the landing page reflects it without waiting
 * for the document to be re-opened. No-op for a doc that isn't in the
 * list.
 */
export function updateRecentDocCover(uid: string, cover: DocumentCover | null): void {
  const list = loadRecentDocs();
  const entry = list.find((d) => d.uid === uid);
  if (!entry) return;
  if (cover) entry.cover = cover;
  else delete entry.cover;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded — best-effort */
  }
}

export function removeFromRecent(uid: string): void {
  const list = loadRecentDocs().filter((d) => d.uid !== uid);
  localStorage.setItem(KEY, JSON.stringify(list));
}

/**
 * Fold a keyring's documents into this browser's list.
 *
 * Which side wins is decided per field by which one is actually better
 * informed. The server holds the synced credential and the document's
 * own state, so `invite_token`, `role`, `cover` and `updated_at` come
 * from there — that is how a token rotated on the laptop reaches the
 * phone. `visited_at` is a fact about *this* browser and is never
 * overwritten, so syncing doesn't reshuffle the list into the order some
 * other device happens to use.
 *
 * Documents in the ring but never opened here sort by when they were
 * added, which lands them below anything actually read on this device.
 */
export function mergeKeyringDocs(incoming: KeyringDocEntry[]): RecentDoc[] {
  const byUid = new Map(loadRecentDocs().map((d) => [d.uid, d]));

  for (const entry of incoming) {
    const local = byUid.get(entry.doc_uid);
    const cover = entry.cover ?? local?.cover;
    const merged: RecentDoc = {
      uid: entry.doc_uid,
      title: entry.title ?? local?.title ?? entry.doc_uid.slice(0, 8),
      // A null role means the invite was revoked or rotated elsewhere.
      // Keep showing what this browser last knew rather than silently
      // demoting the card to reader — opening it is what settles it.
      role: entry.role ?? local?.role ?? 'reader',
      password_protected: entry.password_protected,
      format: entry.format,
      visited_at: local?.visited_at ?? entry.added_at,
      updated_at: Math.max(entry.updated_at, local?.updated_at ?? 0),
      invite_token: entry.invite_token,
      ...(cover ? { cover } : {}),
    };
    byUid.set(entry.doc_uid, merged);
  }

  const merged = [...byUid.values()].sort((a, b) => b.visited_at - a.visited_at).slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    /* quota exceeded — best-effort */
  }
  return merged;
}

const VALID_ROLES = new Set<RecentDoc['role']>(['admin', 'editor', 'collaborator', 'reader']);
const VALID_FORMATS = new Set<DocumentFormat>(['markdown', 'asciidoc']);

/**
 * Validate a stored entry. Returns a one-element array on success,
 * empty on garbage. Invalid or legacy shapes are dropped (except for
 * missing `format`, which defaults to markdown so pre-AsciiDoc
 * entries keep working).
 */
function coerceRecentDoc(v: unknown): RecentDoc[] {
  if (!v || typeof v !== 'object') return [];
  const r = v as Record<string, unknown>;
  if (
    typeof r.uid !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.visited_at !== 'number' ||
    typeof r.updated_at !== 'number' ||
    typeof r.password_protected !== 'boolean' ||
    typeof r.role !== 'string' ||
    !VALID_ROLES.has(r.role as RecentDoc['role'])
  ) {
    return [];
  }
  const format: DocumentFormat = VALID_FORMATS.has(r.format as DocumentFormat)
    ? (r.format as DocumentFormat)
    : 'markdown';
  const cover = coerceCover(r.cover);
  const out: RecentDoc = {
    uid: r.uid,
    title: r.title,
    role: r.role as RecentDoc['role'],
    password_protected: r.password_protected,
    format,
    visited_at: r.visited_at,
    updated_at: r.updated_at,
    ...(typeof r.invite_token === 'string' ? { invite_token: r.invite_token } : {}),
    ...(cover ? { cover } : {}),
  };
  return [out];
}

function coerceCover(v: unknown): DocumentCover | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.ref_name !== 'string' || typeof c.asset_id !== 'string') return null;
  return {
    ref_name: c.ref_name,
    asset_id: c.asset_id,
    mime: typeof c.mime === 'string' ? c.mime : 'application/octet-stream',
  };
}
