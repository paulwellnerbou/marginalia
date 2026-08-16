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
import { clearSavedPassword } from './passwords.js';
import { removeFromRecent } from './recent-docs.js';
import { setUserThemeOverride } from './themes.js';

export function forgetDocumentLocally(uid: string): void {
  // Tombstoned, so an in-flight keyring pull that started before the
  // delete can't merge the document back into the list.
  removeFromRecent(uid);
  // Best-effort server call; the ring is a copy, and a failure here
  // can't be allowed to look like the delete didn't happen.
  removeKeyringDoc(uid);
  clearInviteToken(uid);
  clearSavedPassword(uid);
  setUserThemeOverride(uid, null);
}
