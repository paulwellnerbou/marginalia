import { ApiError, type Document, getDocument } from './api.js';
import { loadInviteToken } from './invite.js';
import { hasKeyring, inviteFromKeyring } from './keyring.js';

/**
 * Load a document for the viewer, with the keyring as the fallback for
 * the link this browser holds.
 *
 * Without a token a bare link opens an invite-only document not at all,
 * and any other only as a reader, even when it is one of ours; so the
 * ring is asked first. A token this browser does hold can have stopped
 * working since, rotated on another device, and the ring may have the
 * new one by now; an invite-only refusal asks it once more.
 */
export async function openDocument(
  uid: string,
  load: (uid: string) => Promise<Document> = getDocument,
): Promise<Document> {
  const held = loadInviteToken(uid);
  if (!held) await inviteFromKeyring(uid);
  try {
    return await load(uid);
  } catch (err) {
    // Without a token of its own the ring was just asked, so asking again
    // would only repeat its answer.
    if (!held || !hasKeyring() || !(err instanceof ApiError) || err.code !== 'invite-required') {
      throw err;
    }
    const fresh = await inviteFromKeyring(uid, { refresh: true });
    if (!fresh || fresh === held) throw err;
    return load(uid);
  }
}
