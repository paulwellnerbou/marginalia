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
 * A browser can hold several rings — one per client or project — so
 * that each one's documents, devices and agent keys stay apart. Every
 * ring authors under the same clientId; only the display name can
 * differ per ring.
 *
 * Every push here is best-effort and silent. Syncing is a convenience
 * layered on top of a browser-local list that already works; a failed
 * PUT must never turn into an error in front of someone who is just
 * trying to read a document. Changes someone asks for by hand — moving
 * a document to another ring, say — are the exception and do throw.
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
import {
  adoptServerName,
  getClientId,
  getDisplayName,
  getDisplayNameSetAt,
  isGeneratedDisplayName,
  type NameScope,
  randomHex,
  setClientId,
  setDisplayName,
  setDocumentNameScopes,
  setNameScope,
} from './identity.js';
import { saveInviteToken } from './invite.js';
import { reportError } from './log.js';
import {
  acknowledgeRemovals,
  dropRingMembership,
  loadRecentDocs,
  mergeKeyringDocs,
  type RecentDoc,
  setRingMembership,
} from './recent-docs.js';

export interface Keyring {
  /** Stable local id; the token changes on rotation, so documents point here. */
  id: string;
  token: string;
  /** What the person calls it ("Acme"). Null for a ring nobody has named. */
  label: string | null;
  /** The name this person goes by in this ring's documents. */
  displayName: string | null;
  /** When that name was chosen; null for unknown or a placeholder. */
  displayNameSetAt: number | null;
}

/** Which documents the home page lists: every one, one ring's, or those in none. */
export type RingView = 'all' | 'unfiled' | string;

const RINGS_KEY = 'marginalia.keyrings';
/** Single-token key still written by tabs running an older version; read into the list. */
const LEGACY_KEY = 'marginalia.keyring';
const KEYRING_EVENT = 'marginalia:keyring-change';
/** Per tab, with the last choice as the default for the next tab. */
const VIEW_KEY = 'marginalia.keyrings.view';
const VIEW_EVENT = 'marginalia:keyring-view-change';
/**
 * Labels of rings a pull found gone, until the home page says so. The
 * viewer pulls too, and the notice is the home page's to show.
 */
const DROPPED_KEY = 'marginalia.keyring.dropped';
/** Per tab: uids a pull did not find in any ring, with when. */
const MISSES_KEY = 'marginalia.keyring.misses';
/** A miss is believed this long; a document can join a ring meanwhile. */
const MISS_TTL_MS = 10 * 60 * 1000;
let pullRequestGeneration = 0;
/** The ring whose name is in use, for a rename to reach. */
let scopedRingId: string | null = null;
/** What the page last scoped to (a document, or null for the home page), to re-scope when rings change. */
let scopeTarget: string | null | undefined;

// --- the list of rings ------------------------------------------------

export function listKeyrings(): Keyring[] {
  migrateLegacyToken();
  try {
    const parsed = JSON.parse(localStorage.getItem(RINGS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.flatMap(coerceRing) : [];
  } catch {
    return [];
  }
}

export function findKeyring(id: string): Keyring | null {
  return listKeyrings().find((ring) => ring.id === id) ?? null;
}

export function hasKeyring(): boolean {
  return listKeyrings().length > 0;
}

/** A ring's name for people: its label, or a stand-in when it has none. */
export function keyringLabel(ring: Pick<Keyring, 'label'>): string {
  return ring.label ?? 'Unnamed project';
}

function storeRings(rings: Keyring[]): void {
  localStorage.setItem(RINGS_KEY, JSON.stringify(rings));
  if (rings.length) localStorage.removeItem(DROPPED_KEY);
  const view = getRingView();
  if (view !== 'all' && view !== 'unfiled' && !rings.some((ring) => ring.id === view)) {
    setRingView('all');
  }
  window.dispatchEvent(new CustomEvent(KEYRING_EVENT, { detail: rings }));
  if (scopeTarget !== undefined) scopeIdentityTo(scopeTarget);
}

function updateRing(id: string, changes: Partial<Omit<Keyring, 'id'>>): void {
  storeRings(listKeyrings().map((ring) => (ring.id === id ? { ...ring, ...changes } : ring)));
}

/** Take over the single token of an older version, which a tab still running one can write. */
function migrateLegacyToken(): void {
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === null) return;
  localStorage.removeItem(LEGACY_KEY);
  let rings: unknown[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(RINGS_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) rings = parsed;
  } catch {
    // Unreadable: the legacy token becomes the list.
  }
  if (rings.flatMap(coerceRing).some((ring) => ring.token === legacy)) return;
  const ring: Keyring = {
    id: newRingId(),
    token: legacy,
    label: null,
    displayName: null,
    displayNameSetAt: null,
  };
  localStorage.setItem(RINGS_KEY, JSON.stringify([...rings, ring]));
}

function newRingId(): string {
  return `ring-${randomHex(6)}`;
}

function coerceRing(v: unknown): Keyring[] {
  if (!v || typeof v !== 'object') return [];
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.token !== 'string') return [];
  return [
    {
      id: r.id,
      token: r.token,
      label: typeof r.label === 'string' && r.label ? r.label : null,
      displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : null,
      displayNameSetAt:
        typeof r.displayNameSetAt === 'number' && Number.isFinite(r.displayNameSetAt)
          ? r.displayNameSetAt
          : null,
    },
  ];
}

/** Subscribe to rings being added, removed, renamed or rotated, here and in other tabs. */
export function onKeyringChange(fn: (rings: Keyring[]) => void): () => void {
  const inApp = () => fn(listKeyrings());
  const crossTab = (e: StorageEvent) => {
    // A tab on an older version writes the single token; reading the list
    // takes it in.
    if (e.key === RINGS_KEY || (e.key === LEGACY_KEY && e.newValue !== null)) {
      fn(listKeyrings());
    }
  };
  window.addEventListener(KEYRING_EVENT, inApp);
  window.addEventListener('storage', crossTab);
  return () => {
    window.removeEventListener(KEYRING_EVENT, inApp);
    window.removeEventListener('storage', crossTab);
  };
}

// --- which ring is in front --------------------------------------------

export function getRingView(): RingView {
  return tabRingView() ?? localStorage.getItem(VIEW_KEY) ?? 'all';
}

/** The view chosen in this tab, as opposed to the default it inherited. */
function tabRingView(): RingView | null {
  try {
    return sessionStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

/**
 * Make the view this tab shows its own choice. For the home page, which
 * lists the inherited view's documents and should file new ones there.
 */
export function claimRingView(): void {
  if (tabRingView() === null) setRingView(getRingView());
}

export function setRingView(view: RingView): void {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // Still remembered below, for this tab and the next.
  }
  localStorage.setItem(VIEW_KEY, view);
  window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: view }));
}

export function onRingViewChange(fn: (view: RingView) => void): () => void {
  const inApp = (e: Event) => fn((e as CustomEvent<RingView>).detail);
  window.addEventListener(VIEW_EVENT, inApp);
  return () => window.removeEventListener(VIEW_EVENT, inApp);
}

/**
 * Where a document that is in no ring goes when it is created or opened
 * here: the only ring, or the one chosen in this tab. Looking at every
 * ring at once, it goes nowhere — filing a client's document under
 * another client is the mistake worth not making on a guess. So does a
 * tab that chose none: a link opened from mail lands in a new tab, and
 * the project last picked in some other tab says nothing about it.
 */
export function filingKeyring(): Keyring | null {
  const rings = listKeyrings();
  if (rings.length === 1) return rings[0] ?? null;
  const view = tabRingView();
  return rings.find((ring) => ring.id === view) ?? null;
}

/** The rings this browser knows to hold a document. */
export function keyringsOf(uid: string, docs: readonly RecentDoc[] = loadRecentDocs()): Keyring[] {
  const ids = docs.find((doc) => doc.uid === uid)?.rings ?? [];
  return listKeyrings().filter((ring) => ids.includes(ring.id));
}

/**
 * The one ring that speaks for a document: the ring in front if it holds
 * it, else the first that does, else the one it would be filed into.
 */
export function keyringForDoc(uid: string): Keyring | null {
  const holding = keyringsOf(uid);
  if (!holding.length) return filingKeyring();
  const view = getRingView();
  return holding.find((ring) => ring.id === view) ?? holding[0] ?? null;
}

/**
 * Use the display name of the ring a document belongs to, or of the ring
 * new documents go into when `uid` is null. With fewer than two rings the
 * browser's own name is the ring's, so nothing is scoped.
 */
export function scopeIdentityTo(uid: string | null): void {
  scopeTarget = uid;
  const ring = uid ? keyringForDoc(uid) : filingKeyring();
  const id = ring && listKeyrings().length > 1 ? ring.id : null;
  if (id === scopedRingId) return;
  scopedRingId = id;
  setNameScope(id ? ringNameScope(id) : null);
}

function ringNameScope(id: string): NameScope {
  return {
    read: () => findKeyring(id)?.displayName ?? null,
    readSetAt: () => findKeyring(id)?.displayNameSetAt ?? null,
    write: (name, setAt) => updateRing(id, { displayName: name, displayNameSetAt: setAt }),
    storageKey: RINGS_KEY,
  };
}

// Each request signs with the name of its own document's ring, whichever
// page is on screen when it is sent.
setDocumentNameScopes((docUid) => {
  if (listKeyrings().length < 2) return null;
  const ring = keyringForDoc(docUid);
  return ring ? ringNameScope(ring.id) : null;
});

// --- creating, joining and leaving -------------------------------------

/**
 * Start a ring. The first one is seeded with everything this browser
 * already holds: the device someone sets this up on is usually the one
 * with all the documents, and an empty first keyring would look like the
 * feature had eaten them. A further ring starts empty; documents are
 * moved into it by hand.
 */
export async function connectKeyring(label: string | null = null): Promise<Keyring> {
  const existing = listKeyrings();
  const seeds: KeyringSeed[] = existing.length
    ? []
    : loadRecentDocs().flatMap((doc) =>
        doc.invite_token
          ? [{ doc_uid: doc.uid, invite_token: doc.invite_token, title: doc.title }]
          : [],
      );
  const wire = await createKeyringRequest(
    seeds,
    { clientId: getClientId(), displayName: getDisplayName() },
    label,
  );
  const ring: Keyring = {
    id: newRingId(),
    token: wire.token,
    label: wire.label ?? label,
    displayName: wire.display_name,
    displayNameSetAt: ringNameSetAt(wire),
  };
  storeRings([...listKeyrings(), ring]);
  mergeKeyringDocs(wire.docs, ring.id, { acknowledgeRemovals: !existing.length });
  if (existing.length) setRingView(ring.id);
  return ring;
}

/**
 * Stop syncing one ring on this device. Its documents stay — the tokens
 * in localStorage are what actually open them, and the keyring was only
 * ever a copy. Deliberately does not delete the ring server-side: other
 * devices are still using it.
 */
export function disconnectKeyring(id: string): void {
  forgetRing(id);
}

function forgetRing(id: string): void {
  pullRequestGeneration++;
  storeRings(listKeyrings().filter((ring) => ring.id !== id));
  dropRingMembership(id);
}

/**
 * Destroy a ring for every device, and stop syncing it here. The opposite
 * end of `disconnectKeyring`: that one leaves the server holding a copy
 * of every invite token in the ring, which is right while another device
 * is still using it and wrong once nobody is.
 *
 * Not best-effort like the pushes — someone asking for their tokens to be
 * deleted has to be told if it didn't happen. A 404 is the exception: the
 * ring is already gone, which is the outcome asked for.
 */
export async function deleteKeyring(id: string): Promise<void> {
  const ring = findKeyring(id);
  if (!ring) return;
  try {
    await deleteKeyringRequest(ring.token);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  forgetRing(id);
}

/** Name a ring, for every device. Throws, since someone typed it. */
export async function renameProject(id: string, label: string): Promise<void> {
  const ring = findKeyring(id);
  if (!ring) return;
  const res = await renameKeyring(ring.token, { label: label.trim() || null });
  updateRing(id, { label: res.label ?? null });
}

/** Replace a ring's token, keeping its documents. For a leak. */
export async function rotateKeyring(id: string): Promise<string | null> {
  const ring = findKeyring(id);
  if (!ring) return null;
  const fresh = await rotateKeyringRequest(ring.token);
  updateRing(id, { token: fresh.token });
  return fresh.token;
}

export interface Paired {
  ring: Keyring;
  docs: RecentDoc[];
  /** The ring authors under another id, and this browser kept its own. */
  identityKept: boolean;
}

/**
 * Redeem a pairing code: add the ring and its documents. The first ring
 * also brings its identity; a browser that already authors under one
 * keeps it, since the alternative strands what it wrote for its other
 * rings.
 */
export async function pairWithCode(code: string): Promise<Paired> {
  const existing = listKeyrings();
  const wire = await redeemKeyringPairing(code, { keepClientId: existing.length > 0 });
  const known = existing.find((ring) => ring.token === wire.token);
  const ring: Keyring = {
    id: known?.id ?? newRingId(),
    token: wire.token,
    label: wire.label ?? null,
    displayName: wire.display_name,
    displayNameSetAt: ringNameSetAt(wire),
  };
  storeRings(known ? existing.map((r) => (r.id === ring.id ? ring : r)) : [...existing, ring]);
  if (!existing.length) adoptIdentity(wire, { clientId: true });
  if (listKeyrings().length > 1) setRingView(ring.id);
  return {
    ring,
    docs: mergeKeyringDocs(wire.docs, ring.id, { acknowledgeRemovals: !existing.length }),
    identityKept: existing.length > 0 && wire.client_id !== getClientId(),
  };
}

// --- pulling -----------------------------------------------------------

export interface KeyringPull {
  /** Merged local list, or null when there was nothing to merge. */
  docs: RecentDoc[] | null;
  /**
   * Labels of rings whose stored token named no ring any more, so they
   * have been dropped here. Why is genuinely unknowable from this side:
   * deleted or rotated away from another device, swept for going unused,
   * or the server's data was reset — once the row is gone the server
   * cannot tell them apart either. The notice this drives names causes as
   * possibilities, never as a closed list.
   */
  dropped: string[];
  /** The server's idle-expiry window. Null until a pull has succeeded. */
  idleTtlMs: number | null;
  /** Every ring answered, so a document none of them listed is in none. */
  complete: boolean;
}

/**
 * Pull every ring and fold each into the local list. All of them, not
 * just the one in front: a pull is what keeps a ring from being swept as
 * unused, and a ring someone switched away from is still in use.
 */
export async function pullKeyring(): Promise<KeyringPull> {
  const nothing: KeyringPull = { docs: null, dropped: [], idleTtlMs: null, complete: false };
  const rings = listKeyrings();
  if (!rings.length) return nothing;
  const generation = ++pullRequestGeneration;
  const results = await Promise.all(
    rings.map(async (ring) => {
      try {
        return { ring, wire: await fetchKeyring(ring.token), err: null };
      } catch (err) {
        return { ring, wire: null, err };
      }
    }),
  );
  // A newer pull—or a ring rotated, moved into or deleted while this one
  // was on the wire—owns the local state now. Do not let this snapshot
  // regress localStorage or the identity adopted from the ring.
  if (generation !== pullRequestGeneration) return nothing;

  const pull: KeyringPull = { docs: null, dropped: [], idleTtlMs: null, complete: true };
  const present = new Set<string>();
  for (const { ring, wire, err } of results) {
    const current = findKeyring(ring.id);
    if (!current || current.token !== ring.token) {
      pull.complete = false;
      continue;
    }
    if (wire) {
      adoptRing(current, wire);
      for (const entry of wire.docs) present.add(entry.doc_uid);
      pull.docs = mergeKeyringDocs(wire.docs, current.id, { acknowledgeRemovals: false });
      pull.idleTtlMs = wire.idle_ttl_ms ?? pull.idleTtlMs;
    } else if (isNotFound(err)) {
      // Drop a dead token rather than retrying it on every page load.
      forgetRing(current.id);
      pull.dropped.push(keyringLabel(current));
    } else {
      pull.complete = false;
      reportError('keyring.pull', err);
    }
  }
  if (pull.complete && pull.docs) acknowledgeRemovals(present);
  if (pull.dropped.length) {
    localStorage.setItem(DROPPED_KEY, JSON.stringify([...readDropped(), ...pull.dropped]));
  }
  return pull;
}

/** Rings a pull found gone since the home page last asked, by label. */
export function takeKeyringDropped(): string[] {
  const dropped = readDropped();
  localStorage.removeItem(DROPPED_KEY);
  return dropped;
}

function readDropped(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DROPPED_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

export interface KeyringInvite {
  token: string | null;
  /** The token comes from a pull just made, not from what this browser already held. */
  fromPull: boolean;
}

/**
 * A ring's link for one document, stored where the viewer looks for
 * it. For a bare `/d/<uid>` link to a document this browser holds no
 * token for, but a ring does: one created on another device, or by an
 * agent, since the last pull. No token without a ring, or when none has one.
 *
 * Any earlier pull has already put the rings' tokens in the local list,
 * so that is asked first; the network only when it knows nothing, and
 * then not again for a while for a document no ring had. `refresh` skips
 * both, for a token that has stopped working.
 */
export async function inviteFromKeyring(
  uid: string,
  opts: { refresh?: boolean } = {},
): Promise<KeyringInvite> {
  if (!hasKeyring()) return { token: null, fromPull: false };
  if (!opts.refresh) {
    const known = loadRecentDocs().find((doc) => doc.uid === uid)?.invite_token;
    if (known) {
      saveInviteToken(uid, known);
      return { token: known, fromPull: false };
    }
    if (recentlyMissed(uid)) return { token: null, fromPull: false };
  }
  const pull = await pullKeyring();
  // A pull another one overtook returns nothing, but the newer one merges
  // into the same list.
  const docs = pull.docs ?? loadRecentDocs();
  const token = docs.find((doc) => doc.uid === uid)?.invite_token ?? null;
  if (token) saveInviteToken(uid, token);
  // Only a pull every ring answered is a miss; a failed ring may hold it.
  else if (pull.complete && pull.docs) rememberMiss(uid);
  return { token, fromPull: pull.docs !== null };
}

function readMisses(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(MISSES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function recentlyMissed(uid: string): boolean {
  const at = readMisses()[uid];
  return typeof at === 'number' && Date.now() - at < MISS_TTL_MS;
}

function rememberMiss(uid: string): void {
  try {
    const now = Date.now();
    const kept = Object.fromEntries(
      Object.entries(readMisses()).filter(([, at]) => now - at < MISS_TTL_MS),
    );
    sessionStorage.setItem(MISSES_KEY, JSON.stringify({ ...kept, [uid]: now }));
  } catch {
    // Without session storage every visit asks again; still correct.
  }
}

// --- documents in rings -----------------------------------------------

/**
 * Record a document's credential in the rings that hold it, or file it
 * into `filingKeyring()` when none does. Called on create, on every visit
 * that carried a token, and after an admin rotation — the last of those
 * is the one that matters most, since a rotated token leaves every other
 * device holding a key that no longer turns.
 *
 * `into` names the rings outright, for a copy that belongs where its
 * original does. Record the visit first: membership is kept on the
 * document's entry in the local list.
 */
export function pushDoc(
  uid: string,
  inviteToken: string,
  title?: string,
  opts: { into?: readonly Keyring[] } = {},
): void {
  const holding = keyringsOf(uid);
  const filing = filingKeyring();
  const targets = opts.into ?? (holding.length ? holding : filing ? [filing] : []);
  // A pull on the wire predates the PUT and would take a new ring's membership away.
  if (targets.some((ring) => !holding.some((h) => h.id === ring.id))) pullRequestGeneration++;
  for (const ring of targets) {
    setRingMembership([uid], ring.id, true);
    void putKeyringDoc(ring.token, uid, {
      invite_token: inviteToken,
      ...(title ? { title } : {}),
    }).catch((err) => {
      if (isNotFound(err)) return;
      // Full, most likely: the ring does not hold it after all.
      setRingMembership([uid], ring.id, false);
      reportError('keyring.pushDoc', err, { uid });
    });
  }
}

/**
 * Forget a document in every ring, mirroring "remove" on the card. Asks
 * every ring rather than only those known to hold it: by the time this
 * runs the local entry that records membership may already be gone.
 */
export function removeDoc(uid: string): void {
  for (const ring of listKeyrings()) {
    void deleteKeyringDoc(ring.token, uid).catch((err) => {
      if (isNotFound(err)) return;
      reportError('keyring.removeDoc', err, { uid });
    });
  }
}

export interface FilableDoc {
  uid: string;
  invite_token: string;
  title?: string;
}

/** Put documents in a ring by hand. Throws, unlike `pushDoc`. */
export async function addDocsToKeyring(docs: readonly FilableDoc[], ringId: string): Promise<void> {
  const ring = findKeyring(ringId);
  if (!ring) throw new Error('unknown-keyring');
  // A pull already on the wire predates this and would undo it.
  pullRequestGeneration++;
  for (const doc of docs) {
    await putKeyringDoc(ring.token, doc.uid, {
      invite_token: doc.invite_token,
      ...(doc.title ? { title: doc.title } : {}),
    });
    setRingMembership([doc.uid], ring.id, true);
  }
}

/** Take documents out of one ring. They stay on this device, and in any other ring. */
export async function removeDocsFromKeyring(
  uids: readonly string[],
  ringId: string,
): Promise<void> {
  const ring = findKeyring(ringId);
  if (!ring) return;
  pullRequestGeneration++;
  for (const uid of uids) {
    try {
      await deleteKeyringDoc(ring.token, uid);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    setRingMembership([uid], ring.id, false);
  }
}

/**
 * Move documents from one ring to another. Added before they are
 * removed, so an interruption leaves them in both rings rather than in
 * neither, and repeating the move finishes it.
 */
export async function moveDocsToKeyring(
  docs: readonly FilableDoc[],
  fromId: string,
  toId: string,
): Promise<void> {
  if (fromId === toId) return;
  await addDocsToKeyring(docs, toId);
  await removeDocsFromKeyring(
    docs.map((doc) => doc.uid),
    fromId,
  );
}

// --- identity ----------------------------------------------------------

/**
 * Push a rename so the other devices pick it up on their next pull: to
 * the ring whose name is in use, or the only one. The per-document
 * rename still happens the way it always did, through the identity
 * headers; this only keeps the shared name from drifting.
 */
export function pushDisplayName(name: string): void {
  const rings = listKeyrings();
  const ring = rings.length === 1 ? rings[0] : rings.find((r) => r.id === scopedRingId);
  if (!ring) return;
  const setAt = name === getDisplayName() ? getDisplayNameSetAt() : null;
  updateRing(ring.id, { displayName: name, displayNameSetAt: setAt });
  void renameKeyring(ring.token, {
    display_name: name,
    display_name_set_at: setAt,
  }).catch((err) => {
    if (isNotFound(err)) return;
    reportError('keyring.pushDisplayName', err);
  });
}

/**
 * Take a document's name for this browser, the way the viewer keeps the
 * header it sends in step with the server. Not in a synced browser: its
 * name is the ring's, and one document's (an invite seeded for someone
 * else, say) must not replace it.
 */
export function adoptDocumentName(
  name: string | null,
  opts: { provisional?: boolean; setAt?: number | null } = {},
): void {
  if (!name || hasKeyring()) return;
  adoptServerName(name, { provisional: opts.provisional === true, setAt: opts.setAt ?? null });
}

/**
 * Keep a ring's label and name as the server has them. The only ring is
 * authoritative for the browser's identity as well — if each device
 * pushed its own name instead, two devices would fight through the
 * server's rename propagation, and a rename would bounce between them
 * forever. With several rings each keeps its own name, and the browser's
 * clientId stays whatever it already authors under.
 */
function adoptRing(ring: Keyring, wire: KeyringWire): void {
  const label = wire.label === undefined ? ring.label : (wire.label ?? null);
  const displayName = wire.display_name || ring.displayName;
  const displayNameSetAt = wire.display_name ? ringNameSetAt(wire) : ring.displayNameSetAt;
  if (
    label !== ring.label ||
    displayName !== ring.displayName ||
    displayNameSetAt !== ring.displayNameSetAt
  ) {
    updateRing(ring.id, { label, displayName, displayNameSetAt });
  }
  // Never the client id: pairing settled that, and a browser left with one
  // of several rings still authors under the id it kept for all of them.
  if (listKeyrings().length === 1) adoptIdentity(wire, { clientId: false });
}

/**
 * The ring's time travels with its name, so a rename typed on another
 * device still out-dates an older name on a personal link here. A ring
 * from before it kept one: a typed name counts as chosen, but oldest.
 */
function ringNameSetAt(wire: KeyringWire): number | null {
  const fallback = isGeneratedDisplayName(wire.display_name) ? null : 0;
  return wire.display_name_set_at ?? fallback;
}

function adoptIdentity(wire: KeyringWire, opts: { clientId: boolean }): void {
  if (opts.clientId && wire.client_id && wire.client_id !== getClientId()) {
    setClientId(wire.client_id);
  }
  if (wire.display_name && wire.display_name !== getDisplayName()) {
    setDisplayName(wire.display_name, { setAt: ringNameSetAt(wire) });
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}
