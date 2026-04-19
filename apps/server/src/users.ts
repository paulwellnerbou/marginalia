import type { Database } from 'bun:sqlite';
import type { Identity } from './auth.js';

/**
 * Per-document user registry (ACCESS_CONTROL Step 4).
 *
 * The registry pins every `(doc_uid, client_id)` pair that has ever
 * authenticated against the document, together with the latest
 * `display_name` the user exposed through the `x-marginalia-client-name`
 * header. Two concerns live here:
 *
 *   1. **Upsert on every request.** `authorize()` calls `upsertDocUser`
 *      after resolving an identity, so even read-only traffic populates
 *      the registry. This is what powers `listMentionCandidates` and
 *      the future name-resolution path.
 *
 *   2. **Rename propagation.** When a user changes their display name,
 *      the upsert detects the diff and rewrites existing
 *      `comments.author_display_name` rows so their authorship label
 *      follows them. Mention targets (stored as bare name strings) are
 *      only rewritten when the OLD name is unambiguous inside this
 *      document — i.e. no other client_id is also using it — so two
 *      people sharing a name can't accidentally relabel each other's
 *      `@mention` rows.
 */

export interface UpsertResult {
  /** Previous display_name for this (doc, client) pair, or null for a
   *  fresh insert / no-op refresh. Non-null means the caller should run
   *  `propagateRename`. */
  oldName: string | null;
}

/**
 * Insert or refresh the doc_users row for this visitor. Returns the
 * previous display_name if it was a rename, so the caller can trigger
 * propagation. No-ops (same name) just bump last_seen_at.
 */
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

/**
 * Rewrite authorship on prior comments and (conditionally) mention targets
 * after a detected rename. Idempotent: running twice with the same
 * parameters is a no-op.
 */
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

  // Only rewrite mention rows if the OLD name is unique to this user in
  // this doc. If another client_id is also using oldName, renaming
  // @oldName would silently steal their @mentions. Leave those rows;
  // the renamed user is free to @-mention themselves again under the new
  // name if they want future notifications.
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
 * Display names known on this document. Sourced from:
 *   1. `doc_users` — everyone who has already authenticated against the
 *      doc. This is the live, rename-tracking source.
 *   2. `invites.display_name` — recipients who have been invited but not
 *      yet visited. Without this you couldn't @-mention someone in a
 *      welcome comment before they showed up.
 *
 * doc_users wins on collision (rename tracking): if an invited user has
 * since renamed, their doc_users row carries the current name, and the
 * invite's stale name is dropped.
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

  // Invited-but-not-yet-visited names — filter to kinds that carry a
  // display_name (admin, named). Generic invites have display_name=NULL.
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
