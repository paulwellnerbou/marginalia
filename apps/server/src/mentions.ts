import type { Database } from 'bun:sqlite';
import { listDocUserNames } from './users.js';

interface MentionMatch {
  targetDisplayNames: string[];
}

/**
 * Mention autocomplete roster. Sourced from `doc_users` (ACCESS_CONTROL
 * Step 4) so the list reflects the CURRENT display name each visitor
 * uses — renames propagate immediately, and "@Alice" suggestions go
 * away the moment Alice renames herself. Invites and comment-author
 * history no longer contribute: both are already reflected in
 * doc_users (the invite's name is set on first-seen, comment authors
 * are always registered), and surfacing stale historical names would
 * defeat the rename flow.
 */
export function listMentionCandidates(db: Database, docUid: string): string[] {
  return listDocUserNames(db, docUid).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

export function storeMentionsForComment(
  db: Database,
  docUid: string,
  commentId: string,
  body: string,
  authorDisplayName: string,
): string[] {
  const targets = resolveMentionTargets(db, docUid, body, authorDisplayName);
  const normalizedTargets = new Set(targets.map((target) => normalizeName(target)));

  const existing = db
    .prepare(
      `SELECT target_display_name, delivered_at
         FROM comment_mentions
        WHERE doc_uid = ? AND comment_id = ?`,
    )
    .all(docUid, commentId) as Array<{ target_display_name: string; delivered_at: number | null }>;
  const pendingToDelete = existing
    .filter(
      (row) =>
        row.delivered_at === null && !normalizedTargets.has(normalizeName(row.target_display_name)),
    )
    .map((row) => row.target_display_name);
  if (pendingToDelete.length > 0) {
    const deleteStmt = db.prepare(
      `DELETE FROM comment_mentions
        WHERE doc_uid = ?
          AND comment_id = ?
          AND lower(target_display_name) = lower(?)
          AND delivered_at IS NULL`,
    );
    for (const target of pendingToDelete) deleteStmt.run(docUid, commentId, target);
  }
  if (targets.length === 0) return [];

  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO comment_mentions
       (doc_uid, comment_id, target_display_name, created_at, delivered_at)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  const inserted: string[] = [];

  for (const target of targets) {
    const result = insert.run(docUid, commentId, target, now);
    if (result.changes > 0) inserted.push(target);
  }

  return inserted;
}

export function consumePendingMentions(
  db: Database,
  docUid: string,
  displayName: string | null,
): string[] {
  const normalized = normalizeName(displayName);
  if (!normalized) return [];

  const rows = db
    .prepare(
      `SELECT DISTINCT comment_id
         FROM comment_mentions
        WHERE doc_uid = ?
          AND lower(target_display_name) = lower(?)
          AND delivered_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all(docUid, normalized) as Array<{ comment_id: string }>;
  if (rows.length === 0) return [];

  db.prepare(
    `UPDATE comment_mentions
        SET delivered_at = ?
      WHERE doc_uid = ?
        AND lower(target_display_name) = lower(?)
        AND delivered_at IS NULL`,
  ).run(Date.now(), docUid, normalized);

  return rows.map((row) => row.comment_id);
}

export function resolveMentionTargets(
  db: Database,
  docUid: string,
  body: string,
  authorDisplayName: string,
): string[] {
  const roster = listMentionCandidates(db, docUid);
  const authorKey = normalizeName(authorDisplayName);
  const names = roster.filter((name) => normalizeName(name) !== authorKey);
  if (names.length === 0) return [];

  const match = parseMentions(body, names);
  const deduped = new Map<string, string>();
  for (const target of match.targetDisplayNames) {
    const key = normalizeName(target);
    if (key) deduped.set(key, target);
  }
  return Array.from(deduped.values());
}

function parseMentions(body: string, roster: string[]): MentionMatch {
  const byNormalized = new Map<string, string>();
  for (const name of roster) {
    const normalized = normalizeName(name);
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, name);
  }

  const candidates = Array.from(byNormalized.values()).sort((a, b) => {
    const lengthDiff = b.length - a.length;
    if (lengthDiff !== 0) return lengthDiff;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  const hits = new Map<string, string>();
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue;
    const prev = i === 0 ? '' : (body[i - 1] ?? '');
    if (isWordLike(prev)) continue;

    const rest = body.slice(i + 1);
    if (startsWithWord(rest, 'all')) {
      for (const name of candidates) hits.set(normalizeName(name), name);
      continue;
    }

    for (const candidate of candidates) {
      if (!startsWithWord(rest, candidate)) continue;
      hits.set(normalizeName(candidate), candidate);
      break;
    }
  }

  return { targetDisplayNames: Array.from(hits.values()) };
}

function startsWithWord(input: string, candidate: string): boolean {
  if (input.length < candidate.length) return false;
  if (input.slice(0, candidate.length).toLowerCase() !== candidate.toLowerCase()) return false;
  return isMentionTerminator(input[candidate.length] ?? '');
}

function isMentionTerminator(ch: string): boolean {
  return ch === '' || !isWordLike(ch);
}

function isWordLike(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch);
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}
