import { ApiError, type Document } from './api.js';
import { apiErrorMessage } from './apiErrorMessage.js';
import { onDisplayNameChange } from './identity.js';
import type { InviteLinkOutcome } from './invite-link.js';
import { dismissToast, showErrorToast, showToast } from './notifications.js';

export const OPEN_NAME_DIALOG_EVENT = 'marginalia:name-dialog';

/** Offer the name dialog without anything waiting on it. */
export function openNameDialog(docUid: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_NAME_DIALOG_EVENT, { detail: { docUid } }));
}

/**
 * A placeholder notice stays up until it is acted on or closed: that is
 * the case where the visitor has something to do. Long, not endless —
 * `setTimeout` treats Infinity as 0.
 */
const PLACEHOLDER_NOTICE_MS = 10 * 60 * 1000;

/** Documents whose placeholder notice this page already showed. */
const placeholderNoticed = new Set<string>();

/**
 * Tell a visitor how others see them: after opening a group link, and on
 * every visit while their name is still the made-up placeholder. Never a
 * blocking dialog — the name is only required once they write something.
 */
export function showIdentityNotice(doc: Document, opened: InviteLinkOutcome | null): void {
  if (opened?.kind === 'refused') {
    // Someone whose own link (or its session) still opens the document has
    // lost nothing; only a visitor left as an anonymous reader needs telling.
    if (doc.display_name !== null) return;
    showErrorToast(
      'This link gives no access of its own',
      apiErrorMessage(new ApiError(410, opened.code), 'This link no longer hands out access.'),
    );
    return;
  }
  const name = doc.display_name;
  if (!name) return;
  if (doc.name_provisional) {
    // Once per document per page: switching tabs back and forth would
    // otherwise pile up copies of a notice that is still on screen.
    if (placeholderNoticed.has(doc.uid)) return;
    placeholderNoticed.add(doc.uid);
    const id = showToast(
      {
        title: `You appear as ${name}`,
        body: 'Others see this name with anything you write. Give your own before you comment.',
        action: { label: 'Use your name', onClick: () => openNameDialog(doc.uid) },
      },
      PLACEHOLDER_NOTICE_MS,
    );
    // Once a name is given, "you appear as" the placeholder is no longer true.
    const stop = onDisplayNameChange(() => {
      dismissToast(id);
      stop();
    });
    window.setTimeout(stop, PLACEHOLDER_NOTICE_MS);
    return;
  }
  if (opened?.kind === 'personal') {
    showToast({
      title: `Continuing as ${name}`,
      body: 'Others see this name with your comments and suggestions.',
      action: { label: 'Change', onClick: () => openNameDialog(doc.uid) },
    });
  }
}
