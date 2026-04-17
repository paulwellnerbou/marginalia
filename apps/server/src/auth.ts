import type { Database } from 'bun:sqlite';
import type { DocumentRow, SessionRow } from './db.js';
import { newSessionToken } from './ids.js';

export const CLIENT_HEADER = 'x-markdowner-client';
export const CLIENT_NAME_HEADER = 'x-markdowner-client-name';
export const SESSION_COOKIE = 'mdn_session';

export interface Identity {
  clientId: string;
  displayName: string;
}

/**
 * Extract client identity from request headers. Both headers are always
 * provided by the client; we treat them as untrusted identity claims,
 * sufficient only for "you can edit your own comment".
 */
export function readIdentity(headers: Headers): Identity | null {
  const clientId = headers.get(CLIENT_HEADER);
  const displayName = headers.get(CLIENT_NAME_HEADER);
  if (!clientId || !displayName) return null;
  if (clientId.length < 8 || clientId.length > 200) return null;
  if (displayName.length < 1 || displayName.length > 80) return null;
  return { clientId, displayName };
}

/**
 * Hash and verify document passwords with Bun's built-in argon2id.
 */
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: 'argon2id' });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

/**
 * Create a session bound to a document. Returns the cookie token.
 * Expiry is enforced on every lookup.
 */
export function createSession(
  db: Database,
  docUid: string,
  ttlMs: number,
): string {
  const token = newSessionToken();
  const expiresAt = Date.now() + ttlMs;
  db.prepare(
    'INSERT INTO sessions (token, doc_uid, expires_at) VALUES (?, ?, ?)',
  ).run(token, docUid, expiresAt);
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
 * Checks whether a request is authorized to access a given document. Returns
 * a structured decision — the caller decides HTTP behavior.
 */
export function authorize(
  db: Database,
  doc: DocumentRow,
  identity: Identity | null,
  sessionToken: string | null,
): AuthDecision {
  if (doc.password_hash === null) {
    return { ok: true, role: roleFor(doc, identity) };
  }
  if (sessionToken && checkSession(db, sessionToken, doc.uid)) {
    return { ok: true, role: roleFor(doc, identity) };
  }
  return { ok: false, reason: 'password-required' };
}

export type Role = 'admin' | 'editor' | 'reader';

function roleFor(doc: DocumentRow, identity: Identity | null): Role {
  if (identity && identity.clientId === doc.admin_client_id) return 'admin';
  if (doc.editable_by_anyone === 1) return 'editor';
  return 'reader';
}

export type AuthDecision =
  | { ok: true; role: Role }
  | { ok: false; reason: 'password-required' | 'forbidden' };
