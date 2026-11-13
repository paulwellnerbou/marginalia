import { useEffect, useRef } from 'react';

/**
 * How a reader has set up one document's view — layout, widths, text
 * size, paper and ink, the open tab, how comments show — kept per
 * document in a single localStorage entry of name → string. The
 * interface size stays per browser (`ui-scale.ts`), and so does the
 * light/dark appearance.
 *
 * A document without an entry of its own reads the per-browser
 * `marginalia.<name>` keys, so a reader's existing sizes carry over
 * instead of resetting. Its first change copies them in, and from then
 * on the entry alone decides — which lets a cleared value mean "unset"
 * rather than "back to the per-browser one".
 */

const PREFS = [
  'readingMode',
  'maxWidth',
  'blockWidth',
  'htmlWidth',
  'textZoom',
  'tocWidth',
  'commentsWidth',
  'inlineCommentsOpen',
  'inlineCommentsStacking',
  'commentsDisplayMode',
  'rightTab',
  'docColors',
  'accent',
  'threadListSort',
  'threadListStatus',
  'threadListKind',
  'threadListReplies',
] as const;

export type DocViewPref = (typeof PREFS)[number];

type PrefStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Prefs = Partial<Record<DocViewPref, string>>;

const PREFIX = 'marginalia.view.';

export function docViewKey(uid: string): string {
  return PREFIX + uid;
}

/** The uid a storage key belongs to, or null for any other key. */
export function docViewUidOf(key: string | null): string | null {
  return key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

function legacyKey(name: DocViewPref): string {
  return `marginalia.${name}`;
}

function readOwn(uid: string, storage: PrefStorage): Prefs | null {
  const raw = storage.getItem(docViewKey(uid));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Prefs = {};
    for (const name of PREFS) {
      const v = (parsed as Record<string, unknown>)[name];
      if (typeof v === 'string') out[name] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function readLegacy(storage: PrefStorage): Prefs {
  const out: Prefs = {};
  for (const name of PREFS) {
    const v = storage.getItem(legacyKey(name));
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Like `localStorage.getItem`, for one setting of one document. */
export function readDocViewPref(
  uid: string,
  name: DocViewPref,
  storage: PrefStorage = localStorage,
): string | null {
  try {
    const own = readOwn(uid, storage);
    if (own) return own[name] ?? null;
    return storage.getItem(legacyKey(name));
  } catch {
    return null;
  }
}

/** `null` clears the setting for this document. */
export function writeDocViewPref(
  uid: string,
  name: DocViewPref,
  value: string | null,
  storage: PrefStorage = localStorage,
): void {
  try {
    const prefs = readOwn(uid, storage) ?? readLegacy(storage);
    if (value === null) delete prefs[name];
    else prefs[name] = value;
    storage.setItem(docViewKey(uid), JSON.stringify(prefs));
  } catch {
    // Private mode / quota: the choice still holds for this page.
  }
}

export function forgetDocViewPrefs(uid: string, storage: PrefStorage = localStorage): void {
  storage.removeItem(docViewKey(uid));
}

interface Persisted {
  uid: string;
  value: string | null;
}

/**
 * Whether a value seen after `prev` is a change to store: only for the
 * same document, since a new uid arrives with that document's own value.
 * `undefined` is a state not worth remembering and leaves the stored one.
 */
export function persistStep(
  prev: Persisted,
  uid: string,
  value: string | null | undefined,
): { write: boolean; next: Persisted } {
  if (value === undefined) return { write: false, next: prev };
  const next = { uid, value };
  return { write: prev.uid === uid && prev.value !== value, next };
}

/**
 * Stores `value` when it changes for the same document, so merely
 * opening one writes nothing and it keeps following the defaults until
 * the reader changes something.
 */
export function usePersistDocViewPref(
  uid: string,
  name: DocViewPref,
  value: string | null | undefined,
): void {
  const last = useRef<Persisted>({ uid, value: value ?? null });
  useEffect(() => {
    const { write, next } = persistStep(last.current, uid, value);
    last.current = next;
    if (write) writeDocViewPref(uid, name, value ?? null);
  }, [uid, name, value]);
}
