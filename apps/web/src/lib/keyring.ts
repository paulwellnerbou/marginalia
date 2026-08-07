/**
 * Client half of the keyring — the thing that makes "your documents" the
 * same list on your laptop and your phone.
 *
 * The model is unchanged underneath: access is still a per-document
 * invite token, still sent as `X-Marginalia-Invite`, still the only
 * thing the server authorizes against. The keyring holds copies of those
 * tokens so a second device can be handed the set at once instead of one
 * pasted link at a time, and carries the clientId so both devices author
 * as the same person.
 *
 * Every push here is best-effort and silent. Syncing is a convenience
 * layered on top of a browser-local list that already works; a failed
 * PUT must never turn into an error in front of someone who is just
 * trying to read a document.
 */

import {
  createKeyring as createKeyringRequest,
  deleteKeyringDoc,
  deleteKeyring as deleteKeyringRequest,
  fetchKeyring,
  type KeyringSeed,
  type KeyringWire,
  putKeyringDoc,
  redeemKeyringPairing,
  renameKeyring,
  rotateKeyring as rotateKeyringRequest,
} from './api.js';
import { getClientId, getDisplayName, setClientId, setDisplayName } from './identity.js';
import { reportError } from './log.js';
import { loadRecentDocs, mergeKeyringDocs, type RecentDoc } from './recent-docs.js';

const KEY = 'marginalia.keyring';
const KEYRING_EVENT = 'marginalia:keyring-change';

export function loadKeyringToken(): string | null {
  return localStorage.getItem(KEY);
}

export function hasKeyring(): boolean {
  return loadKeyringToken() !== null;
}

function storeKeyringToken(token: string | null): void {
  if (token) localStorage.setItem(KEY, token);
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(KEYRING_EVENT, { detail: token }));
}

/** Subscribe to connect/disconnect/rotate, in this tab and across tabs. */
export function onKeyringChange(fn: (token: string | null) => void): () => void {
  const inApp = (e: Event) => fn((e as CustomEvent<string | null>).detail);
  const crossTab = (e: StorageEvent) => {
    if (e.key === KEY) fn(loadKeyringToken());
  };
  window.addEventListener(KEYRING_EVENT, inApp);
  window.addEventListener('storage', crossTab);
  return () => {
    window.removeEventListener(KEYRING_EVENT, inApp);
    window.removeEventListener('storage', crossTab);
  };
}

/**
 * Turn syncing on for this browser, handing the server everything this
 * browser already holds. Seeding from the local list matters: the device
 * someone sets this up on is usually the one with all the documents, and
 * an empty first keyring would look like the feature had eaten them.
 */
export async function connectKeyring(): Promise<KeyringWire & { token: string }> {
  const seeds: KeyringSeed[] = loadRecentDocs().flatMap((doc) =>
    doc.invite_token
      ? [{ doc_uid: doc.uid, invite_token: doc.invite_token, title: doc.title }]
      : [],
  );
  const ring = await createKeyringRequest(seeds, {
    clientId: getClientId(),
    displayName: getDisplayName(),
  });
  storeKeyringToken(ring.token);
  return ring;
}

/**
 * Stop syncing on this device. Local documents stay — the tokens in
 * localStorage are what actually open them, and the keyring was only
 * ever a copy. Deliberately does not delete the ring server-side: other
 * devices are still using it.
 */
export function disconnectKeyring(): void {
  storeKeyringToken(null);
}

/**
 * Destroy the ring for every device, and stop syncing here. The opposite
 * end of `disconnectKeyring`: that one leaves the server holding a copy
 * of every invite token in the ring, which is right while another device
 * is still using it and wrong once nobody is.
 *
 * Not best-effort like the pushes above — someone asking for their
 * tokens to be deleted has to be told if it didn't happen. A 404 is the
 * exception: the ring is already gone, which is the outcome asked for.
 */
export async function deleteKeyring(): Promise<void> {
  const token = loadKeyringToken();
  if (!token) return;
  try {
    await deleteKeyringRequest(token);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  storeKeyringToken(null);
}

/** Pull the ring and fold it into the local list. Null if not connected. */
export async function pullKeyring(): Promise<RecentDoc[] | null> {
  const token = loadKeyringToken();
  if (!token) return null;
  try {
    const ring = await fetchKeyring(token);
    adoptIdentity(ring);
    return mergeKeyringDocs(ring.docs);
  } catch (err) {
    // A 404 means this token no longer names a ring — rotated from
    // another device, or the server's data was reset. Drop it rather
    // than retrying a dead token on every page load.
    if (isNotFound(err)) {
      storeKeyringToken(null);
      return null;
    }
    reportError('keyring.pull', err);
    return null;
  }
}

/**
 * Record a document's credential in the ring. Called on create, on every
 * visit that carried a token, and after an admin rotation — the last of
 * those is the one that matters most, since a rotated token leaves every
 * other device holding a key that no longer turns.
 */
export function pushDoc(uid: string, inviteToken: string, title?: string): void {
  const token = loadKeyringToken();
  if (!token) return;
  void putKeyringDoc(token, uid, {
    invite_token: inviteToken,
    ...(title ? { title } : {}),
  }).catch((err) => {
    if (isNotFound(err)) return;
    reportError('keyring.pushDoc', err, { uid });
  });
}

/** Forget a document ring-wide, mirroring "remove" on the card. */
export function removeDoc(uid: string): void {
  const token = loadKeyringToken();
  if (!token) return;
  void deleteKeyringDoc(token, uid).catch((err) => {
    if (isNotFound(err)) return;
    reportError('keyring.removeDoc', err, { uid });
  });
}

/**
 * Push a rename so the other devices pick it up on their next pull. The
 * per-document rename still happens the way it always did, through the
 * identity headers; this only keeps the shared name from drifting.
 */
export function pushDisplayName(name: string): void {
  const token = loadKeyringToken();
  if (!token) return;
  void renameKeyring(token, name).catch((err) => {
    if (isNotFound(err)) return;
    reportError('keyring.pushDisplayName', err);
  });
}

/** Replace the keyring token, keeping its documents. For a leak. */
export async function rotateKeyring(): Promise<string | null> {
  const token = loadKeyringToken();
  if (!token) return null;
  const fresh = await rotateKeyringRequest(token);
  storeKeyringToken(fresh.token);
  return fresh.token;
}

/** Redeem a pairing code: adopt the ring, its identity, and its documents. */
export async function pairWithCode(code: string): Promise<RecentDoc[]> {
  const ring = await redeemKeyringPairing(code);
  storeKeyringToken(ring.token);
  adoptIdentity(ring);
  return mergeKeyringDocs(ring.docs);
}

/**
 * Take on the ring's identity. The keyring is authoritative for both
 * fields — if each device pushed its own name instead, two devices would
 * fight through the server's rename propagation, and a rename would
 * bounce between them forever.
 */
function adoptIdentity(ring: KeyringWire): void {
  if (ring.client_id && ring.client_id !== getClientId()) setClientId(ring.client_id);
  if (ring.display_name && ring.display_name !== getDisplayName()) {
    setDisplayName(ring.display_name);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}
