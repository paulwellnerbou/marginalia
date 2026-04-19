import type { Database } from 'bun:sqlite';
import type { Identity } from './auth.js';

/**
 * Per-document user registry. Every authenticated request upserts here;
 * renames (same clientId, different display_name) fan out to existing
 * comments + mentions. Mention rewrite skips when the old name is also
 * used by another client_id in this doc — otherwise the rename would
 * silently steal the other user's @mentions.
 */

export interface UpsertResult {
  /** Non-null ⇒ a rename happened; caller runs `propagateRename`. */
  oldName: string | null;
}

export function upsertDocUser(
  db: Database,
  docUid: string,
  identity: Identity,
): UpsertResult {
  const now = Date.now();
  // bun:sqlite's `.get()` returns null (not undefined) when no row matches.
  const prev = db
    .prepare('SELECT display_name FROM doc_users WHERE doc_uid = ? AND client_id = ?')
    .get(docUid, identity.clientId) as { display_name: string } | null | undefined;

  if (prev === undefined || prev === null) {
    db.prepare(
      `INSERT INTO doc_users
         (doc_uid, client_id, display_name, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(docUid, identity.clientId, identity.displayName, now, now);
    return { oldName: null };
  }

  if (prev.display_name === identity.displayName) {
    db.prepare(
      `UPDATE doc_users SET last_seen_at = ?
         WHERE doc_uid = ? AND client_id = ?`,
    ).run(now, docUid, identity.clientId);
    return { oldName: null };
  }

  db.prepare(
    `UPDATE doc_users SET display_name = ?, last_seen_at = ?
       WHERE doc_uid = ? AND client_id = ?`,
  ).run(identity.displayName, now, docUid, identity.clientId);
  return { oldName: prev.display_name };
}

/** Rewrite authorship + unambiguous mentions. Idempotent. */
export function propagateRename(
  db: Database,
  docUid: string,
  clientId: string,
  oldName: string,
  newName: string,
): void {
  if (oldName === newName) return;

  db.prepare(
    `UPDATE comments
        SET author_display_name = ?, updated_at = ?
      WHERE doc_uid = ? AND author_client_id = ?`,
  ).run(newName, Date.now(), docUid, clientId);

  // Skip the mention rewrite when another client_id still uses oldName
  // — otherwise we'd redirect the other user's @mentions to the renamed
  // user.
  const collision = db
    .prepare(
      `SELECT count(*) AS n FROM doc_users
         WHERE doc_uid = ? AND display_name = ? AND client_id != ?`,
    )
    .get(docUid, oldName, clientId) as { n: number };
  if (collision.n > 0) return;

  db.prepare(
    `UPDATE comment_mentions
        SET target_display_name = ?
      WHERE doc_uid = ? AND target_display_name = ?`,
  ).run(newName, docUid, oldName);
}

/**
 * Known display names: doc_users first (live, rename-tracked), then
 * invited-but-not-yet-visited recipients so you can @-mention them in a
 * welcome comment. doc_users entries win on collision, so stale invite
 * names disappear after a rename.
 */
export function listDocUserNames(db: Database, docUid: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const users = db
    .prepare(
      `SELECT display_name FROM doc_users
         WHERE doc_uid = ?
         ORDER BY last_seen_at DESC`,
    )
    .all(docUid) as Array<{ display_name: string }>;
  for (const row of users) addName(out, seen, row.display_name);

  // Generic invites have display_name NULL; admin + named carry one.
  const invited = db
    .prepare(
      `SELECT display_name FROM invites
         WHERE doc_uid = ? AND display_name IS NOT NULL
         ORDER BY created_at ASC`,
    )
    .all(docUid) as Array<{ display_name: string | null }>;
  for (const row of invited) {
    if (row.display_name) addName(out, seen, row.display_name);
  }

  return out;
}

function addName(out: string[], seen: Set<string>, name: string): void {
  const key = name.trim().toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(name);
}
