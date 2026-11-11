import type { Database } from 'bun:sqlite';
import type { InviteRole, InviteRow } from './db.js';
import { newInviteToken } from './ids.js';

/**
 * Group links: one link for many people. Opening it mints a personal
 * link per visitor — an ordinary named invite whose `source_token` is the
 * group link — so the admin sees, re-roles and revokes people one by one.
 * The group token itself is never a credential (see `authorize`).
 *
 * A personal link's name is the person's, not the admin's. It starts as
 * the visitor's own chosen name, or as their generated placeholder marked
 * provisional, and every visible write is refused until it is real.
 */

export const NAME_SET_AT_HEADER = 'x-marginalia-name-set-at';

/** Names kept per personal link, newest first. */
const NAME_HISTORY_LIMIT = 20;

/** `last_used_at` is for a human glancing at the panel; minutes are plenty. */
const LAST_USED_RESOLUTION_MS = 10 * 60 * 1000;

const ROLE_RANK: Record<InviteRole, number> = {
  reader: 0,
  collaborator: 1,
  editor: 2,
  admin: 3,
};

export function roleAtLeast(role: InviteRole, floor: InviteRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[floor];
}

export function isPersonalLink(
  invite: InviteRow | null | undefined,
): invite is InviteRow & { source_token: string } {
  return !!invite && invite.kind === 'named' && invite.source_token !== null;
}

/**
 * When the browser says its name was chosen. Absent means generated, and
 * a generated name never renames anyone. Clamped to now: a device with a
 * fast clock would otherwise win every later dispute.
 */
export function readNameSetAt(headers: Headers, now: number = Date.now()): number | null {
  const raw = headers.get(NAME_SET_AT_HEADER);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), now);
}

/**
 * The name a request on a personal link signs as, renaming the link when
 * the request carries a newer chosen name. The link's stored name wins
 * otherwise, so a second device holding an older name adopts the newer
 * one instead of renaming the person back.
 *
 * The unchanged-but-dated case clears the placeholder flag: someone who
 * deliberately keeps "Amber Fox" has chosen it.
 */
export function resolvePersonalName(
  db: Database,
  invite: InviteRow,
  headerName: string | null,
  headerSetAt: number | null,
  now: number = Date.now(),
): { displayName: string; provisional: boolean; setAt: number | null } {
  const stored = invite.display_name ?? headerName ?? '';
  const storedSetAt = invite.name_set_at ?? -1;
  const changes = headerName !== null && (headerName !== stored || invite.name_provisional === 1);
  if (changes && headerSetAt !== null && headerSetAt > storedSetAt) {
    db.prepare(
      `UPDATE invites
          SET display_name = ?, name_set_at = ?, name_provisional = 0
        WHERE token = ?`,
    ).run(headerName, headerSetAt, invite.token);
    recordName(db, invite.token, invite.doc_uid, headerName, headerSetAt, now);
    return { displayName: headerName, provisional: false, setAt: headerSetAt };
  }
  return {
    displayName: stored,
    provisional: invite.name_provisional === 1,
    setAt: invite.name_set_at,
  };
}

export function touchLastUsed(db: Database, invite: InviteRow, now: number = Date.now()): void {
  if (invite.last_used_at !== null && now - invite.last_used_at < LAST_USED_RESOLUTION_MS) return;
  db.prepare('UPDATE invites SET last_used_at = ? WHERE token = ?').run(now, invite.token);
}

function recordName(
  db: Database,
  token: string,
  docUid: string,
  displayName: string,
  setAt: number | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO invite_names (invite_token, doc_uid, display_name, set_at, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, docUid, displayName, setAt, now);
  db.prepare(
    `DELETE FROM invite_names
      WHERE invite_token = ?
        AND rowid NOT IN (
          SELECT rowid FROM invite_names WHERE invite_token = ?
           ORDER BY recorded_at DESC, rowid DESC LIMIT ?)`,
  ).run(token, token, NAME_HISTORY_LIMIT);
}

/**
 * Names each personal link of a document carried before its current one,
 * newest first. Consecutive repeats collapse, so a rename and back reads
 * as two names rather than three.
 */
export function previousNamesByInvite(db: Database, docUid: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT invite_token, display_name FROM invite_names
        WHERE doc_uid = ?
        ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(docUid) as Array<{ invite_token: string; display_name: string }>;
  const out = new Map<string, string[]>();
  const firstSeen = new Set<string>();
  for (const row of rows) {
    // The newest row is the current name, which the invite row already says.
    if (!firstSeen.has(row.invite_token)) {
      firstSeen.add(row.invite_token);
      continue;
    }
    const list = out.get(row.invite_token) ?? [];
    if (list[list.length - 1] !== row.display_name) list.push(row.display_name);
    out.set(row.invite_token, list);
  }
  return out;
}

export function deleteNameHistory(db: Database, token: string): void {
  db.prepare('DELETE FROM invite_names WHERE invite_token = ?').run(token);
}

export function deleteDocNameHistory(db: Database, docUid: string): void {
  db.prepare('DELETE FROM invite_names WHERE doc_uid = ?').run(docUid);
}

export function personalLinkCount(db: Database, groupToken: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM invites WHERE source_token = ?')
    .get(groupToken) as { n: number };
  return row.n;
}

/**
 * Mint a personal link from `group`. The caller has checked the gate, the
 * rate limit and the cap, and runs this inside the same transaction as
 * the cap's count.
 */
export function mintPersonalLink(
  db: Database,
  group: InviteRow,
  name: { displayName: string; setAt: number | null },
  now: number = Date.now(),
): InviteRow {
  const token = newInviteToken();
  const provisional = name.setAt === null ? 1 : 0;
  db.prepare(
    `INSERT INTO invites
       (token, doc_uid, display_name, role, kind, note, created_at, created_by_name,
        source_token, name_provisional, name_set_at, last_used_at)
     VALUES (?, ?, ?, ?, 'named', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    group.doc_uid,
    name.displayName,
    group.role,
    now,
    group.created_by_name,
    group.token,
    provisional,
    name.setAt,
    now,
  );
  recordName(db, token, group.doc_uid, name.displayName, name.setAt, now);
  return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow;
}

/** Every personal link a group link handed out, then the group link. */
export function revokeGroupLink(db: Database, groupToken: string): string[] {
  const tokens = (
    db.prepare('SELECT token FROM invites WHERE source_token = ?').all(groupToken) as Array<{
      token: string;
    }>
  ).map((r) => r.token);
  for (const token of tokens) {
    db.prepare('DELETE FROM invites WHERE token = ?').run(token);
    db.prepare('DELETE FROM sessions WHERE invite_token = ?').run(token);
    deleteNameHistory(db, token);
  }
  db.prepare('DELETE FROM invites WHERE token = ?').run(groupToken);
  return tokens;
}
