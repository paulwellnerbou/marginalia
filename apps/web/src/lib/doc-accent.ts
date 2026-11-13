import { normalizeAccent } from '@marginalia/themes/accent';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { docViewUidOf, readDocViewPref, writeDocViewPref } from './doc-view-prefs.js';

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

/** Stored when the reader wants the theme's accent over a document default. */
const THEME_OVERRIDE = 'theme';

export interface DocAccent {
  /** What the document is shown with; null is the theme's own. */
  accent: string | null;
  /** The reader's stored choice: a hex, `'theme'`, or null to follow the document. */
  override: string | null;
  docDefault: string | null;
}

/** What a stored override and the document's default come to. */
export function effectiveAccent(override: string | null, docDefault: string | null): string | null {
  if (override === THEME_OVERRIDE) return null;
  return normalizeAccent(override) ?? docDefault;
}

/** What to store for a choice (a hex, or null for the theme's): nothing when it is the document's. */
export function accentOverrideFor(next: string | null, docDefault: string | null): string | null {
  const accent = normalizeAccent(next);
  if (accent === docDefault) return null;
  return accent ?? THEME_OVERRIDE;
}

/**
 * One step down the chain: a pick falls back to the document's default,
 * the document's default to the theme's. Null when already at the theme's.
 */
export function accentResetTarget(state: DocAccent): 'document' | 'theme' | null {
  if (state.override !== null) return state.docDefault !== null ? 'document' : 'theme';
  return state.docDefault !== null ? 'theme' : null;
}

interface Cached {
  raw: string | null;
  value: DocAccent;
}

const docDefaults = new Map<string, string | null>();
const cache = new Map<string, Cached>();
const listeners = new Set<() => void>();
const NONE: DocAccent = { accent: null, override: null, docDefault: null };

function build(uid: string, raw: string | null): Cached {
  const override = raw === THEME_OVERRIDE ? raw : normalizeAccent(raw);
  const docDefault = docDefaults.get(uid) ?? null;
  return { raw, value: { accent: effectiveAccent(override, docDefault), override, docDefault } };
}

function snapshot(uid: string): DocAccent {
  let entry = cache.get(uid);
  if (!entry) {
    entry = build(uid, readDocViewPref(uid, 'accent'));
    cache.set(uid, entry);
  }
  return entry.value;
}

function notify(): void {
  for (const l of listeners) l();
}

/** Another tab changed this document's view settings; only an accent change re-renders. */
function onStorage(event: StorageEvent): void {
  if (event.key === null) cache.clear();
  else {
    const uid = docViewUidOf(event.key);
    const entry = uid === null ? undefined : cache.get(uid);
    if (uid === null || !entry) return;
    const raw = readDocViewPref(uid, 'accent');
    if (raw === entry.raw) return;
    cache.set(uid, build(uid, raw));
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Store the reader's choice: a hex, `'theme'`, or null to follow the document. */
function writeOverride(uid: string, raw: string | null): void {
  cache.set(uid, build(uid, raw));
  writeDocViewPref(uid, 'accent', raw);
  notify();
}

/** The reader picks an accent (a hex), or the theme's own (null). */
export function setDocAccent(uid: string, next: string | null): void {
  writeOverride(uid, accentOverrideFor(next, docDefaults.get(uid) ?? null));
}

/** Takes the step `accentResetTarget` names. */
export function resetDocAccent(uid: string): void {
  const state = snapshot(uid);
  if (state.override !== null) writeOverride(uid, null);
  else if (state.docDefault !== null) writeOverride(uid, THEME_OVERRIDE);
}

/** After the reader's choice became the document's default, they follow it. */
export function clearDocAccentOverride(uid: string): void {
  writeOverride(uid, null);
}

export function setDocAccentDefault(uid: string, accent: string | null): void {
  const next = normalizeAccent(accent);
  if (docDefaults.has(uid) && docDefaults.get(uid) === next) return;
  docDefaults.set(uid, next);
  const entry = cache.get(uid);
  if (entry) cache.set(uid, build(uid, entry.raw));
  notify();
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

export function useDocAccent(uid: string | undefined): DocAccent {
  return useSyncExternalStore(subscribe, () => (uid ? snapshot(uid) : NONE));
}
