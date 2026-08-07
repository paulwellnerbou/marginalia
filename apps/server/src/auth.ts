import type { Database } from 'bun:sqlite';
import type { DocumentRow, InviteRow, SessionRow } from './db.js';
import { newSessionToken } from './ids.js';
import { propagateRename, upsertDocUser } from './users.js';

export const CLIENT_HEADER = 'x-marginalia-client';
export const CLIENT_NAME_HEADER = 'x-marginalia-client-name';
export const INVITE_HEADER = 'x-marginalia-invite';
export const SESSION_COOKIE = 'marginalia_session';
export const INVITE_SESSION_COOKIE = 'marginalia_invite_session';

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

export function createSession(
  db: Database,
  docUid: string,
  ttlMs: number,
  persistent = true,
  invite?: { display_name: string | null; role: string; kind: string } | null,
): string {
  const token = newSessionToken();
  const expiresAt = Date.now() + ttlMs;
  db.prepare(
    `INSERT INTO sessions
       (token, doc_uid, persistent, expires_at, invite_display_name, invite_role, invite_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    docUid,
    persistent ? 1 : 0,
    expiresAt,
    invite?.display_name ?? null,
    invite?.role ?? null,
    invite?.kind ?? null,
  );
  return token;
}

export function readSession(db: Database, token: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as
    | SessionRow
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function checkSession(db: Database, token: string, docUid: string): boolean {
  const row = readSession(db, token);
  return row?.doc_uid === docUid;
}

export function deleteSession(db: Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
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
 * Precedence:
 *   1. Password gate  — if doc has a hash, a password session is mandatory.
 *                       Invite sessions do NOT satisfy the password gate.
 *   2. Invite header  — admin-kind invite always takes precedence over an
 *                       invite session so a user can "upgrade" to admin
 *                       by presenting an admin token.
 *   3. Invite session — a session cookie minted by POST /invites/:token/claim;
 *                       uses the stored role + display_name from the session row.
 *   4. Non-admin invite header — named/generic invite token in the header.
 *   5. No invite      — reader, identity comes from headers if present,
 *                       unless the doc is invite_only, which removes that
 *                       fallback entirely. Both gates are independent: a
 *                       password-protected invite_only doc needs both.
 *
 * Returns one resolved identity so callers don't re-derive authorship.
 */
export function authorize(
  db: Database,
  doc: DocumentRow,
  headers: Headers,
  sessionToken: string | null,
  inviteSessionToken?: string | null,
): AuthDecision {
  const passwordSession = sessionToken ? readSession(db, sessionToken) : null;
  const validPasswordSession = passwordSession?.doc_uid === doc.uid ? passwordSession : null;

  const invSession = inviteSessionToken ? readSession(db, inviteSessionToken) : null;
  const validInviteSession = invSession?.doc_uid === doc.uid ? invSession : null;
  const isInviteSession = !!validInviteSession?.invite_role;

  // Password gate is unconditional — invites (including admin) and invite
  // sessions never bypass it. Only a password-type session satisfies it.
  if (doc.password_hash !== null) {
    if (!validPasswordSession) {
      return { ok: false, reason: 'password-required' };
    }
  }

  const invite = readInvite(db, headers, doc.uid);
  const clientId = readClientId(headers);
  const base = readIdentity(headers);

  // Admin invites always take priority over an invite session so the user
  // can "upgrade" to a higher-privilege role even after a session was minted.
  if (invite?.kind === 'admin') {
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

  // Invite session: minted by POST /invites/:token/claim. Takes precedence
  // over non-admin invite headers so the browser no longer needs the token URL.
  // Only reachable for non-password-protected docs (password gate above
  // rejects requests without a password session for password-protected docs).
  if (isInviteSession) {
    const role = validInviteSession!.invite_role as Role;
    // Same name-resolution logic as named/admin invites: seeded name on
    // first visit, header (user rename) wins on subsequent requests.
    let resolvedName = validInviteSession!.invite_display_name ?? base?.displayName ?? '';
    if (clientId) {
      const prior = db
        .prepare('SELECT display_name FROM doc_users WHERE doc_uid = ? AND client_id = ?')
        .get(doc.uid, clientId) as { display_name: string } | null | undefined;
      if (prior?.display_name) {
        resolvedName = base?.displayName ?? prior.display_name;
      }
    }
    const identity = clientId && resolvedName ? { clientId, displayName: resolvedName } : null;
    return recordAndReturn(db, doc.uid, {
      ok: true,
      role,
      identity,
      invite: null,
      isInviteSession: true,
    });
  }

  if (invite) {
    if (invite.kind === 'generic') {
      // Visitor's own name is the identity. Missing → identity is null,
      // write endpoints reject; reads don't need a name.
      const identity = clientId && base ? { clientId, displayName: base.displayName } : null;
      return recordAndReturn(db, doc.uid, { ok: true, role: invite.role, identity, invite });
    }

    // named: invite name seeds on first visit (no doc_users row),
    // header wins thereafter so UserMenu renames propagate via the upsert
    // diff. Prevents a browser with a stale local name from accidentally
    // inheriting the invite's identity.
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

  // Invite-only: the URL alone is not a credential, so there is no
  // anonymous role to fall back to. Every path that could have granted
  // one — admin/named/generic invite header, claimed invite session —
  // has already returned above.
  if (doc.invite_only === 1) {
    return { ok: false, reason: 'invite-required' };
  }

  // No invite → read-only. To get comment / propose / edit rights, an
  // admin must mint an invite for this visitor.
  return recordAndReturn(db, doc.uid, { ok: true, role: 'reader', identity: base, invite: null });
}

/**
 * Side-effect: upsert doc_users on every authenticated request that has
 * a non-null identity; on a name diff, fan out the rename to prior
 * comments + mentions. Anonymous callers (identity null) are skipped.
 */
function recordAndReturn(db: Database, docUid: string, decision: AuthDecision): AuthDecision {
  if (!decision.ok || !decision.identity) return decision;

  const { clientId, displayName } = decision.identity;
  syncAdminInviteDisplayName(db, decision.invite, displayName);
  const { oldName } = upsertDocUser(db, docUid, decision.identity);

  if (oldName !== null && oldName !== displayName) {
    propagateRename(db, docUid, clientId, oldName, displayName);
  }
  return decision;
}

function syncAdminInviteDisplayName(
  db: Database,
  invite: InviteRow | null,
  displayName: string,
): void {
  if (!invite || invite.kind !== 'admin') return;
  if (invite.display_name === displayName) return;
  db.prepare(
    `UPDATE invites
        SET display_name = ?
      WHERE token = ? AND kind = 'admin'`,
  ).run(displayName, invite.token);
}

export type AuthDecision =
  | {
      ok: true;
      role: Role;
      identity: Identity | null;
      invite: InviteRow | null;
      /**
       * True when access was granted via a session cookie minted by the
       * claim-invite route (POST /invites/:token/claim). Absent/false for
       * all other auth paths (password session, invite header, anonymous).
       */
      isInviteSession?: boolean;
    }
  | { ok: false; reason: 'password-required' | 'invite-required' | 'forbidden' };
