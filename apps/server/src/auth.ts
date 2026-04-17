import type { Database } from 'bun:sqlite';
import type { DocumentRow, InviteRow, SessionRow } from './db.js';
import { newSessionToken } from './ids.js';

export const CLIENT_HEADER = 'x-marginalia-client';
export const CLIENT_NAME_HEADER = 'x-marginalia-client-name';
export const INVITE_HEADER = 'x-marginalia-invite';
export const SESSION_COOKIE = 'marginalia_session';

export interface Identity {
  clientId: string;
  displayName: string;
}

export type Role = 'admin' | 'editor' | 'reader';

/**
 * Raw identity headers from the request. clientId is the random per-browser
 * marker (used for "delete your own comment" checks), displayName is the
 * name the browser currently shows. The server may override displayName
 * with the invite's name when one is present — that's the whole point of
 * invites.
 */
export function readIdentity(headers: Headers): Identity | null {
  const clientId = headers.get(CLIENT_HEADER);
  const rawName = headers.get(CLIENT_NAME_HEADER);
  if (!clientId || !rawName) return null;
  const displayName = decodeHeaderValue(rawName);
  if (clientId.length < 8 || clientId.length > 200) return null;
  if (displayName.length < 1 || displayName.length > 80) return null;
  return { clientId, displayName };
}

function decodeHeaderValue(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Fetch the invite referenced by the `x-marginalia-invite` header, if any. */
export function readInvite(db: Database, headers: Headers, docUid: string): InviteRow | null {
  const token = headers.get(INVITE_HEADER);
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM invites WHERE token = ? AND doc_uid = ?')
    .get(token, docUid) as InviteRow | undefined;
  return row ?? null;
}

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'argon2id' });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export function createSession(db: Database, docUid: string, ttlMs: number): string {
  const token = newSessionToken();
  const expiresAt = Date.now() + ttlMs;
  db.prepare('INSERT INTO sessions (token, doc_uid, expires_at) VALUES (?, ?, ?)').run(
    token,
    docUid,
    expiresAt,
  );
  return token;
}

export function checkSession(db: Database, token: string, docUid: string): boolean {
  const row = db
    .prepare('SELECT * FROM sessions WHERE token = ? AND doc_uid = ?')
    .get(token, docUid) as SessionRow | undefined;
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * Can this request access this document, and in what role?
 *
 * Order of precedence:
 * 1. Invite token → carries role + forced display_name.
 * 2. Password session (if doc is password-protected) + identity → reader or
 *    editor based on `editable_by_anyone`.
 * 3. Public doc + identity → reader or editor based on `editable_by_anyone`.
 *
 * Returns the resolved identity (display_name overridden by invite when
 * present) so callers use a single source of truth for authorship.
 */
export function authorize(
  db: Database,
  doc: DocumentRow,
  headers: Headers,
  sessionToken: string | null,
): AuthDecision {
  const invite = readInvite(db, headers, doc.uid);
  const base = readIdentity(headers);

  if (invite) {
    const identity = base
      ? { clientId: base.clientId, displayName: invite.display_name }
      : null;
    return { ok: true, role: invite.role, identity, invite };
  }

  if (doc.password_hash !== null) {
    if (!sessionToken || !checkSession(db, sessionToken, doc.uid)) {
      return { ok: false, reason: 'password-or-invite-required' };
    }
  }

  const role: Role = doc.editable_by_anyone === 1 ? 'editor' : 'reader';
  return { ok: true, role, identity: base, invite: null };
}

export type AuthDecision =
  | { ok: true; role: Role; identity: Identity | null; invite: InviteRow | null }
  | { ok: false; reason: 'password-or-invite-required' | 'forbidden' };
