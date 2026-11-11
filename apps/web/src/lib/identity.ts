/**
 * A user is identified by a `clientId` (random, auto-generated on first
 * visit) and a `displayName` (generated on first use, user-editable
 * later). Both live in localStorage; the server treats them as untrusted
 * identity claims.
 */

import { useEffect, useState } from 'react';

const CLIENT_ID_KEY = 'marginalia.clientId';
const DISPLAY_NAME_KEY = 'marginalia.displayName';
/**
 * When the person chose the current name (ms), or `generated` for the
 * name this browser made up. Absent on browsers from before it existed;
 * see `getDisplayNameSetAt`. Sent with every request so a personal link
 * takes the newest chosen name and never a generated one.
 */
const DISPLAY_NAME_SET_AT_KEY = 'marginalia.displayNameSetAt';
const GENERATED = 'generated';
const DISPLAY_NAME_EVENT = 'marginalia:display-name-change';

const NAME_ADJECTIVES = [
  'Amber',
  'Brisk',
  'Calm',
  'Clever',
  'Cloudy',
  'Copper',
  'Coral',
  'Crimson',
  'Dapper',
  'Drift',
  'Ember',
  'Fable',
  'Fern',
  'Golden',
  'Harbor',
  'Hazel',
  'Indigo',
  'Ivy',
  'Juniper',
  'Kind',
  'Lively',
  'Maple',
  'Meadow',
  'Merry',
  'Misty',
  'Nimble',
  'Olive',
  'Opal',
  'Pine',
  'Quiet',
  'River',
  'Rosy',
  'Sage',
  'Silver',
  'Sky',
  'Solar',
  'Spruce',
  'Starry',
  'Sunny',
  'Swift',
  'Timber',
  'Velvet',
  'Willow',
  'Witty',
];

const NAME_ANIMALS = [
  'Badger',
  'Bear',
  'Beaver',
  'Crane',
  'Crow',
  'Dolphin',
  'Falcon',
  'Finch',
  'Fox',
  'Gecko',
  'Gull',
  'Hedgehog',
  'Heron',
  'Jay',
  'Koala',
  'Lark',
  'Lynx',
  'Marten',
  'Moose',
  'Newt',
  'Otter',
  'Owl',
  'Panda',
  'Peregrine',
  'Pika',
  'Quail',
  'Raven',
  'Robin',
  'Seal',
  'Sparrow',
  'Stag',
  'Swan',
  'Swift',
  'Tern',
  'Tiger',
  'Toucan',
  'Trout',
  'Viper',
  'Walrus',
  'Wren',
  'Yak',
  'Zebra',
];

export interface Identity {
  clientId: string;
  displayName: string;
}

/**
 * Somewhere other than the browser-wide slot to keep the display name:
 * the keyring whose documents are on screen, for someone who goes by a
 * different name with each of several clients.
 */
export interface NameScope {
  read(): string | null;
  /** When `read`'s name was chosen; null for unknown or a placeholder. */
  readSetAt(): number | null;
  write(name: string, setAt: number | null): void;
  /** localStorage key `read` depends on, so other tabs' writes are heard. */
  storageKey: string;
}

let nameScope: NameScope | null = null;
/** The scope one document's requests use, which can differ from the page's. */
let docNameScope: ((docUid: string) => NameScope | null) | null = null;

/** Point reads and writes of the display name at `scope`, or back at the browser's own. */
export function setNameScope(scope: NameScope | null): void {
  if (scope === nameScope) return;
  nameScope = scope;
  window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: getDisplayName() }));
}

/** How to find the scope a given document's requests sign with. */
export function setDocumentNameScopes(
  resolve: ((docUid: string) => NameScope | null) | null,
): void {
  docNameScope = resolve;
}

/**
 * The name a request for `docUid` signs with: its own keyring's, so a
 * request still running for the document being left does not carry the
 * next one's name. Without a document, or a name for it, the page's.
 */
export function getDisplayNameFor(docUid?: string): string {
  const scope = docUid ? docNameScope?.(docUid) : null;
  return normalizeDisplayName(scope?.read() ?? '') || getDisplayName();
}

/** When `getDisplayNameFor(docUid)` was chosen. */
export function getDisplayNameSetAtFor(docUid?: string): number | null {
  const scope = docUid ? docNameScope?.(docUid) : null;
  return scope && normalizeDisplayName(scope.read() ?? '')
    ? scope.readSetAt()
    : getDisplayNameSetAt();
}

/** Get or create a persistent clientId. */
export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = generateClientId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/**
 * Overwrite the browser's clientId. Only pairing does this: adopting the
 * keyring's clientId is what makes several devices one author rather
 * than several people who happen to share a name — same doc_users row,
 * so a comment written on one is editable on the other.
 *
 * Comments already written on this device under the old id stay behind;
 * they keep their author name but stop being editable here. Pairing a
 * device that has its own history is the rare case, and silently
 * rewriting authorship server-side would be worse.
 */
export function setClientId(clientId: string): void {
  if (!clientId) return;
  localStorage.setItem(CLIENT_ID_KEY, clientId);
}

export function getDisplayName(): string {
  const scoped = normalizeDisplayName(nameScope?.read() ?? '');
  if (scoped) return scoped;
  const existing = normalizeDisplayName(localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  if (existing && !isLegacyDefaultDisplayName(existing)) {
    if (existing !== localStorage.getItem(DISPLAY_NAME_KEY)) {
      localStorage.setItem(DISPLAY_NAME_KEY, existing);
    }
    return existing;
  }

  const generated = generateDisplayName(getClientId());
  localStorage.setItem(DISPLAY_NAME_KEY, generated);
  localStorage.setItem(DISPLAY_NAME_SET_AT_KEY, GENERATED);
  return generated;
}

/**
 * When the current name was chosen, or null for a generated one.
 *
 * A browser from before this was recorded counts a name as chosen when it
 * is not the one its own client id generates — at time 0, so it can name
 * a new personal link but never out-date a name chosen anywhere since.
 */
export function getDisplayNameSetAt(): number | null {
  if (nameScope && normalizeDisplayName(nameScope.read() ?? '')) return nameScope.readSetAt();
  const name = getDisplayName();
  const raw = localStorage.getItem(DISPLAY_NAME_SET_AT_KEY);
  if (raw === GENERATED) return null;
  if (raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return isGeneratedDisplayName(name) ? null : 0;
}

/**
 * Take the name a document's server resolved for this browser, with its
 * time: none for a placeholder, so it never renames anyone, and 0 for a
 * name an admin gave, which is chosen but older than any typed since.
 *
 * The same name only teaches an undated local copy its time. Without
 * that, a name chosen on another device stays "made up" here, and the
 * next group link this browser opens would ask for it all over again.
 */
export function adoptServerName(
  name: string,
  server: { provisional: boolean; setAt: number | null },
): void {
  const serverSetAt = server.provisional ? null : (server.setAt ?? 0);
  if (getDisplayName() !== name) {
    setDisplayName(name, { setAt: serverSetAt });
    return;
  }
  if (getDisplayNameSetAt() === null && serverSetAt !== null) {
    setDisplayName(name, { setAt: serverSetAt });
  }
}

/** Is this the placeholder name this browser would make up for itself? */
export function isGeneratedDisplayName(name: string): boolean {
  return normalizeDisplayName(name) === generateDisplayName(getClientId());
}

/**
 * `setAt` is when the name was chosen: now for a name the person typed
 * (the default), the server's time when adopting a name from it, null for
 * a placeholder. Re-saving the same name keeps its time unless one is
 * given, so merely confirming a name never out-dates a newer one.
 */
export function setDisplayName(name: string, opts: { setAt?: number | null } = {}): void {
  const prev = nameScope ? getDisplayName() : localStorage.getItem(DISPLAY_NAME_KEY);
  const typed = normalizeDisplayName(name);
  const next = typed || generateDisplayName(getClientId());
  const changed = opts.setAt !== undefined || next !== prev;
  const setAt = !typed ? null : opts.setAt === undefined ? Date.now() : opts.setAt;
  if (nameScope) {
    nameScope.write(next, changed ? setAt : nameScope.readSetAt());
  } else {
    localStorage.setItem(DISPLAY_NAME_KEY, next);
    if (changed) {
      localStorage.setItem(DISPLAY_NAME_SET_AT_KEY, setAt === null ? GENERATED : String(setAt));
    }
  }
  // Notify in-app subscribers even when the value didn't change — they
  // may be re-reading to sync React state.
  window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: next }));
  // Also bridge the cross-tab `storage` channel manually — StorageEvent
  // only fires in *other* tabs, never the one that did the write.
  void prev;
}

/**
 * Subscribe to changes to the display name made anywhere in the app (same
 * tab via `setDisplayName` or cross-tab via the native `storage` event).
 */
export function onDisplayNameChange(fn: (name: string) => void): () => void {
  const inApp = (e: Event) => fn((e as CustomEvent<string>).detail);
  const crossTab = (e: StorageEvent) => {
    if (e.key === DISPLAY_NAME_KEY || (nameScope && e.key === nameScope.storageKey)) {
      fn(getDisplayName());
    }
  };
  window.addEventListener(DISPLAY_NAME_EVENT, inApp);
  window.addEventListener('storage', crossTab);
  return () => {
    window.removeEventListener(DISPLAY_NAME_EVENT, inApp);
    window.removeEventListener('storage', crossTab);
  };
}

/** Reactive hook: the current display name, kept in sync with updates
 *  from anywhere in the app. */
export function useDisplayName(): string {
  const [name, setName] = useState<string>(() => getDisplayName());
  useEffect(() => onDisplayNameChange((next) => setName(next)), []);
  return name;
}

/**
 * Returns the current browser identity. Both fields are created lazily on
 * first use and then remain stable until the display name is edited.
 */
export function loadIdentity(): Identity {
  const clientId = getClientId();
  const displayName = getDisplayName();
  return { clientId, displayName };
}

/**
 * Derive a display name from markdown content — used as the fallback when
 * the upload form's display-name field is left empty.
 *
 * Order of precedence:
 * 1. YAML frontmatter `title:` (first one found)
 * 2. First non-empty line outside frontmatter, with leading `#` markers
 *    stripped.
 * 3. 'Anonymous' if neither is present.
 */
export function deriveDisplayName(markdown: string): string {
  const lines = markdown.split('\n');

  let i = 0;
  // Skip a leading YAML frontmatter block and capture its title.
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '---') {
        i++;
        break;
      }
      const m = line.match(/^\s*title\s*:\s*(.+?)\s*$/);
      if (m) {
        const raw = m[1]!.replace(/^["']|["']$/g, '').trim();
        if (raw) return raw.slice(0, 80);
      }
    }
  }

  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, '').slice(0, 80);
  }
  return 'Anonymous';
}

function generateClientId(): string {
  return randomHex(16);
}

/** `byteCount` random bytes as lowercase hex. */
export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeDisplayName(name: string): string {
  return name.trim().slice(0, 80);
}

function isLegacyDefaultDisplayName(name: string): boolean {
  return name.toLowerCase() === 'agent';
}

function generateDisplayName(clientId: string): string {
  const adjective = NAME_ADJECTIVES[indexFromClientId(clientId, 0, NAME_ADJECTIVES.length)];
  const animal = NAME_ANIMALS[indexFromClientId(clientId, 8, NAME_ANIMALS.length)];
  return `${adjective} ${animal}`;
}

function indexFromClientId(clientId: string, start: number, modulo: number): number {
  return parseInt(clientId.slice(start, start + 8), 16) % modulo;
}
