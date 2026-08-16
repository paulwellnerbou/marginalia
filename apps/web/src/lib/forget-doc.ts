/**
 * Drop every trace of one document from this browser.
 *
 * The per-document state is spread across four independent stores plus
 * the keyring, each written by whichever feature owns it. Collecting the
 * removals here means a caller that has just destroyed a document
 * server-side doesn't have to know that list — and doesn't leave a dead
 * invite token or a saved password for a uid that no longer resolves.
 */

import { clearInviteToken } from './invite.js';
import { removeDoc as removeKeyringDoc } from './keyring.js';
import { reportError } from './log.js';
import { clearSavedPassword } from './passwords.js';
import { removeFromRecent } from './recent-docs.js';
import { setUserThemeOverride } from './themes.js';

export function forgetDocumentLocally(uid: string): void {
  // Tombstoned, so an in-flight keyring pull that started before the
  // delete can't merge the document back into the list.
  attempt(uid, 'recentDocs', () => removeFromRecent(uid));
  // Best-effort server call; the ring is a copy, and a failure here
  // can't be allowed to look like the delete didn't happen.
  attempt(uid, 'keyring', () => removeKeyringDoc(uid));
  attempt(uid, 'invite', () => clearInviteToken(uid));
  attempt(uid, 'password', () => clearSavedPassword(uid));
  attempt(uid, 'theme', () => setUserThemeOverride(uid, null));
}

/**
 * Only some of the stores above guard their own localStorage writes, and
 * every one of them runs *after* the server has destroyed the document.
 * A browser that refuses to write — private mode, blocked storage, full
 * quota — must not be able to make a completed delete report as failed,
 * nor let one dead store leave the other four untouched. Logged, not
 * swallowed silently: leftover local state is a real (if harmless) bug
 * worth seeing in the console.
 */
function attempt(uid: string, store: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    reportError('forgetDocumentLocally', err, { uid, store });
  }
}
