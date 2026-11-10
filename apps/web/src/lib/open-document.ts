import { ApiError, type Document, getDocument } from './api.js';
import { loadInviteToken } from './invite.js';
import { hasKeyring, inviteFromKeyring } from './keyring.js';
import { loadRecentDocs } from './recent-docs.js';

type Load = (uid: string) => Promise<Document>;

/**
 * Load a document for the viewer, with the keyring as the fallback for
 * the link this browser holds.
 *
 * Without a token a bare link opens an invite-only document not at all,
 * and any other only as a reader, even when it is one of ours; so the
 * ring is asked first. A token this browser holds, or took from its local
 * list, can have stopped working since, rotated on another device, and
 * the ring may have the new one by now: asked once more when the
 * document refuses it, or opens only as a reader where this browser knew
 * it as more.
 */
export async function openDocument(uid: string, load: Load = getDocument): Promise<Document> {
  let fromPull = false;
  if (!loadInviteToken(uid)) fromPull = (await inviteFromKeyring(uid)).fromPull;
  const used = loadInviteToken(uid);
  const knownRole = loadRecentDocs().find((doc) => doc.uid === uid)?.role;
  // A token a pull just handed over is the ring's current one; asking
  // again would only repeat its answer.
  const renewable = !!used && !fromPull && hasKeyring();

  let doc: Document;
  try {
    doc = await load(uid);
  } catch (err) {
    if (!renewable || !(err instanceof ApiError) || err.code !== 'invite-required') throw err;
    const retried = await withRingToken(uid, used, load);
    if (!retried) throw err;
    return retried;
  }
  // A dead token on a document anyone may read is ignored, not refused.
  if (renewable && doc.role === 'reader' && knownRole && knownRole !== 'reader') {
    return (await withRingToken(uid, used, load)) ?? doc;
  }
  return doc;
}

async function withRingToken(uid: string, used: string | null, load: Load) {
  const { token } = await inviteFromKeyring(uid, { refresh: true });
  if (!token || token === used) return null;
  return load(uid);
}
