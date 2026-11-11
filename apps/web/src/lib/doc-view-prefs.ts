import { useEffect, useRef } from 'react';

/**
 * How a reader has set up one document's view — layout, widths, text
 * size, paper and ink, the open tab, how comments show — kept per
 * document in a single localStorage entry of name → string. The
 * interface size stays per browser (`ui-scale.ts`), and so does the
 * light/dark appearance.
 *
 * These were per browser once, under `marginalia.<name>`. A document
 * without an entry of its own still reads those, so nobody's sizes reset;
 * its first change copies them in, and from then on the entry alone
 * decides — which lets a cleared value mean "unset" rather than "back to
 * the old global".
 */

export type DocViewPref =
  | 'readingMode'
  | 'maxWidth'
  | 'blockWidth'
  | 'htmlWidth'
  | 'textZoom'
  | 'tocWidth'
  | 'commentsWidth'
  | 'inlineCommentsOpen'
  | 'inlineCommentsStacking'
  | 'commentsDisplayMode'
  | 'rightTab'
  | 'docColors'
  | 'threadListSort'
  | 'threadListStatus'
  | 'threadListKind'
  | 'threadListReplies';

const PREFS: readonly DocViewPref[] = [
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
  'threadListSort',
  'threadListStatus',
  'threadListKind',
  'threadListReplies',
];

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

/**
 * Stores `value` when it changes for the same document, so merely
 * opening one writes nothing and it keeps following the defaults until
 * the reader changes something. A new `uid` arrives with that document's
 * own value, which needs no writing back.
 */
export function usePersistDocViewPref(uid: string, name: DocViewPref, value: string | null): void {
  const last = useRef({ uid, value });
  useEffect(() => {
    const prev = last.current;
    last.current = { uid, value };
    if (prev.uid === uid && prev.value !== value) writeDocViewPref(uid, name, value);
  }, [uid, name, value]);
}
