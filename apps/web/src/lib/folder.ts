import type { DocumentFolder } from './api.js';
import { loadInviteToken, saveInviteToken } from './invite.js';

/**
 * A folder is the documents that share one set of access: its main
 * document's links, password and sessions open every one of them. The
 * server decides that; these helpers keep this browser's per-document
 * token store in step with it.
 */

/** "A", "A and B", "A, B and C" — for naming a folder's documents in prose. */
export function listTitles(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** The uid of every document in `folder` other than `uid`. */
export function otherFolderUids(folder: DocumentFolder | null | undefined, uid: string): string[] {
  return folder ? folder.documents.map((d) => d.uid).filter((other) => other !== uid) : [];
}

/**
 * Store the token this browser opens `uid` with under every other
 * document in its folder that has none yet. The same token opens them
 * all, and a plain `/d/<uid>` link — the folder list's, or one opened in
 * a new tab — only finds it under that document's own uid.
 *
 * A token already stored is left alone: it may be a different person's
 * link someone opened here on purpose.
 */
export function shareFolderToken(folder: DocumentFolder | null | undefined, uid: string): void {
  const token = loadInviteToken(uid);
  if (!token) return;
  for (const other of otherFolderUids(folder, uid)) {
    if (!loadInviteToken(other)) saveInviteToken(other, token);
  }
}

/**
 * After the admin link is rotated, the old token opens nothing in the
 * folder. Swap it for the new one wherever this browser stored it, and
 * return those uids so the caller can sync them onwards.
 */
export function replaceFolderToken(
  uids: readonly string[],
  oldToken: string | null,
  newToken: string,
): string[] {
  if (!oldToken) return [];
  const changed: string[] = [];
  for (const uid of uids) {
    if (loadInviteToken(uid) !== oldToken) continue;
    saveInviteToken(uid, newToken);
    changed.push(uid);
  }
  return changed;
}
