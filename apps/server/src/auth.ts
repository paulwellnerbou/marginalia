import type { Database } from 'bun:sqlite';
import type { DocumentRow, InviteRow, SessionRow } from './db.js';
import { newSessionToken } from './ids.js';
import { propagateRename, upsertDocUser } from './users.js';

export const CLIENT_HEADER = 'x-marginalia-client';
export const CLIENT_NAME_HEADER = 'x-marginalia-client-name';
export const INVITE_HEADER = 'x-marginalia-invite';
export const SESSION_COOKIE = 'marginalia_session';

export interface Identity {
  clientId: string;
  displayName: string;
}

export type Role = 'admin' | 'editor' | 'collaborator' | 'reader';

export function canEdit(role: Role): boolean {
  return role === 'admin' || role === 'editor';
}

export function canComment(role: Role): boolean {
  return role !== 'reader';
}

/**
 * Can this role create or modify edit proposals? Same truth-value as
 * `canComment` today, but kept as its own predicate so the proposal
 * routes read as "this needs propose rights" instead of borrowing the
 * comment gate. If the role hierarchy ever splits comment from propose
 * (the spec briefly considered it), only this function changes.
 */
export function canPropose(role: Role): boolean {
  return role === 'admin' || role === 'editor' || role === 'collaborator';
}

/**
 * Raw identity headers from the request. clientId is the random per-browser
 * marker (used for "delete your own comment" checks), displayName is the
 * name the browser currently shows. The server may override displayName
 * with the invite's name when one is present — that's the whole point of
 * invites.
 */
export function readIdentity(headers: Headers): Identity | null {
  const clientId = readClientId(headers);
  const rawName = headers.get(CLIENT_NAME_HEADER);
  if (!clientId || !rawName) return null;
  const displayName = decodeHeaderValue(rawName);
  if (displayName.length < 1 || displayName.length > 80) return null;
  return { clientId, displayName };
}

export function readClientId(headers: Headers): string | null {
  const clientId = headers.get(CLIENT_HEADER);
  if (!clientId) return null;
  if (clientId.length < 8 || clientId.length > 200) return null;
  return clientId;
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
 * 1. Password gate (if doc is password-protected) — always required.
 * 2. Invite token → carries role + forced display_name.
 * 3. No invite → reader role with whatever identity the headers carry.
 *
 * Returns the resolved identity (display_name overridden by invite when
 * present) so callers use a single source of truth for authorship.
 *
 * NOTE: ACCESS_CONTROL Step 2 retired the `editable_by_anyone` toggle.
 * Granting non-reader rights is now exclusively done via invites — Step 3
 * adds a "generic" invite kind that fills the role of the old toggle for
 * use cases like "anyone with the URL can comment". The column survives
 * on `documents` for one release as legacy data; this function no longer
 * reads it.
 */
export function authorize(
  db: Database,
  doc: DocumentRow,
  headers: Headers,
  sessionToken: string | null,
): AuthDecision {
  const invite = readInvite(db, headers, doc.uid);
  const clientId = readClientId(headers);
  const base = readIdentity(headers);

  // If the document is password-protected, the password is always a gate.
  // Even an invite (which decides who you are + what you can do) doesn't
  // bypass the password — you need both the capability (invite URL) and
  // the secret (password / session cookie). Admin invites are no exception.
  if (doc.password_hash !== null) {
    if (!sessionToken || !checkSession(db, sessionToken, doc.uid)) {
      return { ok: false, reason: 'password-required' };
    }
  }

  if (invite) {
    if (invite.kind === 'generic') {
      // Generic invite: visitor brings their own name. The header-supplied
      // identity IS the identity — if it's missing, caller must provide
      // one before any write endpoint will accept the request. Read-only
      // endpoints (listComments, getDocument) still work without a name
      // because only the role is needed.
      const identity = clientId && base ? { clientId, displayName: base.displayName } : null;
      return recordAndReturn(db, doc.uid, { ok: true, role: invite.role, identity, invite });
    }

    // admin + named: invite-name-as-seed semantics (ACCESS_CONTROL Step 4,
    // revised by Step 6 review).
    //
    // First visit under this invite (no doc_users row for this clientId
    // yet) → identity is the INVITE's display_name, regardless of what
    // the header says. Prevents a browser with a pre-existing local
    // name from silently inheriting the invite's identity while still
    // carrying the wrong name into `doc_users`.
    //
    // Subsequent visits → header wins, so an intentional rename via the
    // UserMenu flows through as a detectable change (upsert picks up the
    // diff, propagateRename rewrites prior comments and @mentions).
    let resolvedName: string;
    if (clientId) {
      const prior = db
        .prepare('SELECT display_name FROM doc_users WHERE doc_uid = ? AND client_id = ?')
        .get(doc.uid, clientId) as { display_name: string } | null | undefined;
      if (prior && prior.display_name) {
        resolvedName = base?.displayName ?? prior.display_name;
      } else {
        resolvedName = invite.display_name ?? base?.displayName ?? '';
      }
    } else {
      resolvedName = invite.display_name ?? base?.displayName ?? '';
    }
    const identity = clientId && resolvedName ? { clientId, displayName: resolvedName } : null;
    return recordAndReturn(db, doc.uid, { ok: true, role: invite.role, identity, invite });
  }

  // No invite → read-only. To get comment / propose / edit rights, an
  // admin must mint an invite for this visitor.
  return recordAndReturn(db, doc.uid, { ok: true, role: 'reader', identity: base, invite: null });
}

/**
 * Side-effect shim: update the per-doc user registry for every
 * authenticated request and propagate rename changes to prior comments /
 * mentions. No-op when identity is null (anonymous readers aren't
 * tracked — we'd pollute the registry with client_ids that never
 * contributed content).
 *
 * For admin/named invites, `authorize()` above enforces the
 * "invite name on first visit" rule, so by the time we get here the
 * identity.displayName is either:
 *   (a) exactly `invite.display_name` on first visit, or
 *   (b) the user's chosen name on subsequent visits.
 *
 * Rename detection is therefore a simple diff: upsertDocUser reports
 * the previous display_name; if it differs from the resolved identity,
 * we propagate the rename across prior comments + mentions.
 */
function recordAndReturn(db: Database, docUid: string, decision: AuthDecision): AuthDecision {
  if (!decision.ok || !decision.identity) return decision;

  const { clientId, displayName } = decision.identity;
  const { oldName } = upsertDocUser(db, docUid, decision.identity);

  if (oldName !== null && oldName !== displayName) {
    propagateRename(db, docUid, clientId, oldName, displayName);
  }
  return decision;
}

export type AuthDecision =
  | { ok: true; role: Role; identity: Identity | null; invite: InviteRow | null }
  | { ok: false; reason: 'password-required' | 'forbidden' };
