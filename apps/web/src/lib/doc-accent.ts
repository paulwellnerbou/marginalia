import { normalizeAccent } from '@marginalia/themes/accent';
import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { liveDocViewPref, setLiveDocViewPref, useLiveDocViewPref } from './doc-view-prefs.js';

/**
 * The accent color a document is shown with: the reader's own pick, else
 * the document's default, else the theme's. One color for both
 * appearances; `accentCssVars` derives the shades for each.
 *
 * The reader's pick lives with the other view settings. The document's
 * default comes with the document, and is registered here by the page
 * that loaded it, so every rendering of the document (proposal previews
 * included) follows it without threading it through as a prop.
 */

/**
 * Stored as `theme:<default>` when the reader prefers the theme's accent
 * over a document default: it opts out of that default only, so a new
 * default, or none, ends it.
 */
const THEME_PREFIX = 'theme:';

export interface DocAccent {
  /** What the document is shown with; null is the theme's own. */
  accent: string | null;
  /** The reader's choice in force: a hex, `'theme'`, or null to follow the document. */
  override: string | null;
  docDefault: string | null;
}

/** What a stored choice comes to against the document's current default. */
export function resolveAccent(raw: string | null, docDefault: string | null): DocAccent {
  let override: string | null;
  if (raw?.startsWith(THEME_PREFIX)) {
    override =
      docDefault !== null && raw.slice(THEME_PREFIX.length) === docDefault ? 'theme' : null;
  } else {
    override = normalizeAccent(raw);
  }
  const accent = override === 'theme' ? null : (override ?? docDefault);
  return { accent, override, docDefault };
}

/** What to store for a choice (a hex, or null for the theme's): nothing when it is the document's. */
export function accentOverrideFor(next: string | null, docDefault: string | null): string | null {
  const accent = normalizeAccent(next);
  if (accent === docDefault) return null;
  return accent ?? `${THEME_PREFIX}${docDefault}`;
}

/**
 * One step down the chain: a pick falls back to the document's default,
 * the document's default to the theme's. Null when already at the theme's.
 */
export function accentResetTarget(state: DocAccent): 'document' | 'theme' | null {
  if (state.override !== null) return state.docDefault !== null ? 'document' : 'theme';
  return state.docDefault !== null ? 'theme' : null;
}

// --- Document defaults ----------------------------------------------

const docDefaults = new Map<string, string | null>();
const defaultListeners = new Set<() => void>();
/** Tells this browser's other tabs about a default changed here. */
let channel: BroadcastChannel | null | undefined;

function openChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel('marginalia.doc-accent-default');
    channel?.addEventListener('message', (event: MessageEvent) => {
      const { uid, accent } = (event.data ?? {}) as { uid?: unknown; accent?: unknown };
      if (typeof uid === 'string') setDocAccentDefault(uid, normalizeAccent(accent));
    });
  }
  return channel;
}

function subscribeDefaults(listener: () => void): () => void {
  openChannel();
  defaultListeners.add(listener);
  return () => defaultListeners.delete(listener);
}

function defaultOf(uid: string): string | null {
  return docDefaults.get(uid) ?? null;
}

export function setDocAccentDefault(uid: string, accent: string | null): void {
  const next = normalizeAccent(accent);
  if (docDefaults.has(uid) && docDefaults.get(uid) === next) return;
  docDefaults.set(uid, next);
  for (const l of defaultListeners) l();
}

/** A default this tab just saved: here and in this browser's other tabs. */
export function announceDocAccentDefault(uid: string, accent: string | null): void {
  setDocAccentDefault(uid, accent);
  openChannel()?.postMessage({ uid, accent: normalizeAccent(accent) });
}

/**
 * Registers the loaded document's default. A layout effect, so the first
 * paint already shows it rather than the theme's accent for a frame.
 */
export function useDocAccentDefault(
  uid: string | undefined,
  accent: string | null | undefined,
): void {
  useLayoutEffect(() => {
    if (uid && accent !== undefined) setDocAccentDefault(uid, accent);
  }, [uid, accent]);
}

// --- The reader's choice --------------------------------------------

/** The reader picks an accent (a hex), or the theme's own (null). */
export function setDocAccent(uid: string, next: string | null): void {
  setLiveDocViewPref(uid, 'accent', accentOverrideFor(next, defaultOf(uid)));
}

/** Takes the step `accentResetTarget` names. */
export function resetDocAccent(uid: string): void {
  const state = resolveAccent(liveDocViewPref(uid, 'accent'), defaultOf(uid));
  if (state.override !== null) setLiveDocViewPref(uid, 'accent', null);
  else if (state.docDefault !== null) {
    setLiveDocViewPref(uid, 'accent', `${THEME_PREFIX}${state.docDefault}`);
  }
}

/** After the reader's choice became the document's default, they follow it. */
export function clearDocAccentOverride(uid: string): void {
  setLiveDocViewPref(uid, 'accent', null);
}

export function useDocAccent(uid: string | undefined): DocAccent {
  const raw = useLiveDocViewPref(uid, 'accent');
  const docDefault = useSyncExternalStore(subscribeDefaults, () => (uid ? defaultOf(uid) : null));
  return useMemo(() => resolveAccent(raw, docDefault), [raw, docDefault]);
}
