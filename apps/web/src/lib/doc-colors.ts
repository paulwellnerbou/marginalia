import { accentCssVars } from '@marginalia/themes/accent';
import { type CSSProperties, useMemo, useSyncExternalStore } from 'react';
import type { DocumentFormat } from './api.js';
import { useAppearance } from './appearance.js';
import { useDocAccent } from './doc-accent.js';
import { docViewUidOf, readDocViewPref, writeDocViewPref } from './doc-view-prefs.js';

/**
 * The reader's own paper and ink, overriding the theme's
 * `--md-color-bg` / `--md-color-fg`. Kept per appearance, since a paper
 * picked for light mode is wrong in dark mode, and per document, like the
 * other view settings, rather than per theme.
 */

export type DocColorRole = 'bg' | 'fg';
export type DocColorMode = 'light' | 'dark';
export type DocColors = Partial<Record<DocColorRole, string>>;
export type DocColorOverrides = Partial<Record<DocColorMode, DocColors>>;

const HEX = /^#[0-9a-f]{6}$/;
const ROLES: readonly DocColorRole[] = ['bg', 'fg'];
const MODES: readonly DocColorMode[] = ['light', 'dark'];

/** Drops anything that isn't a `#rrggbb` the native color input can show. */
export function parseDocColors(raw: string | null): DocColorOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: DocColorOverrides = {};
  for (const mode of MODES) {
    const entry = (parsed as Record<string, unknown>)[mode];
    if (!entry || typeof entry !== 'object') continue;
    const colors: DocColors = {};
    for (const role of ROLES) {
      const v = (entry as Record<string, unknown>)[role];
      if (typeof v === 'string' && HEX.test(v.toLowerCase())) colors[role] = v.toLowerCase();
    }
    if (Object.keys(colors).length > 0) out[mode] = colors;
  }
  return out;
}

export function withDocColor(
  overrides: DocColorOverrides,
  mode: DocColorMode,
  role: DocColorRole,
  value: string | null,
): DocColorOverrides {
  const colors: DocColors = { ...overrides[mode] };
  if (value && HEX.test(value.toLowerCase())) colors[role] = value.toLowerCase();
  else delete colors[role];
  const next: DocColorOverrides = { ...overrides };
  if (Object.keys(colors).length > 0) next[mode] = colors;
  else delete next[mode];
  return next;
}

interface Cached {
  raw: string | null;
  value: DocColorOverrides;
}

function load(docUid: string): Cached {
  const raw = readDocViewPref(docUid, 'docColors');
  return { raw, value: parseDocColors(raw) };
}

const NONE: DocColorOverrides = {};
/** Per uid, so a snapshot keeps its identity between renders. */
const cache = new Map<string, Cached>();
const listeners = new Set<() => void>();

function snapshot(docUid: string): DocColorOverrides {
  let entry = cache.get(docUid);
  if (!entry) {
    entry = load(docUid);
    cache.set(docUid, entry);
  }
  return entry.value;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/**
 * Another tab changed a document's view settings, or cleared storage.
 * The entry holds every view setting, and a pane drag elsewhere writes
 * it repeatedly, so only a change to the colors themselves re-renders.
 */
function onStorage(event: StorageEvent): void {
  if (event.key === null) cache.clear();
  else {
    const uid = docViewUidOf(event.key);
    const entry = uid === null ? undefined : cache.get(uid);
    if (uid === null || !entry) return;
    const fresh = load(uid);
    if (fresh.raw === entry.raw) return;
    cache.set(uid, fresh);
  }
  for (const l of listeners) l();
}

export function setDocColor(
  docUid: string,
  mode: DocColorMode,
  role: DocColorRole,
  value: string | null,
): void {
  const next = withDocColor(snapshot(docUid), mode, role, value);
  const raw = Object.keys(next).length > 0 ? JSON.stringify(next) : null;
  cache.set(docUid, { raw, value: next });
  writeDocViewPref(docUid, 'docColors', raw);
  for (const l of listeners) l();
}

/** The overrides for the appearance the page is showing right now. */
export function useDocColors(docUid: string | undefined): {
  mode: DocColorMode;
  colors: DocColors;
} {
  const { resolved } = useAppearance();
  const all = useSyncExternalStore(subscribe, () => (docUid ? snapshot(docUid) : NONE));
  return { mode: resolved, colors: all[resolved] ?? {} };
}

/**
 * Inline, because every `.marginalia-theme` and `.marginalia` element
 * redeclares the theme's colors, so an override set only on an ancestor
 * would be shadowed one level down.
 */
export function docColorStyle(
  colors: DocColors,
  accent?: { hex: string; mode: DocColorMode },
): CSSProperties | undefined {
  if (!colors.bg && !colors.fg && !accent) return undefined;
  return {
    ...(accent ? accentCssVars(accent.hex, accent.mode) : {}),
    ...(colors.bg ? { ['--md-color-bg' as string]: colors.bg } : {}),
    ...(colors.fg ? { ['--md-color-fg' as string]: colors.fg } : {}),
  };
}

/**
 * The style every rendering of a document carries, so previews match the
 * reader's paper and accent. HTML pages bring their own look and get none.
 */
export function useDocColorStyle(
  docUid: string | undefined,
  format: DocumentFormat | undefined,
): CSSProperties | undefined {
  const { mode, colors } = useDocColors(docUid);
  const { accent } = useDocAccent(docUid);
  const { bg, fg } = colors;
  return useMemo(
    () =>
      format === 'html'
        ? undefined
        : docColorStyle(
            { ...(bg ? { bg } : {}), ...(fg ? { fg } : {}) },
            accent ? { hex: accent, mode } : undefined,
          ),
    [format, bg, fg, accent, mode],
  );
}

/**
 * A computed CSS color as `#rrggbb`, or null when it is (partly)
 * transparent. Only handles the `rgb()`/`rgba()` serialization browsers
 * give for computed `color` and `background-color`.
 */
export function rgbToHex(computed: string): string | null {
  const m = computed.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  if (m[4] !== undefined) {
    const alpha = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    if (alpha < 1) return null;
  }
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What the reader actually sees behind `el`: its own background or the
 * first opaque one above it — in dark mode the themes leave the paper
 * transparent and let the app surface show through.
 */
export function effectiveBackground(el: Element | null): string | null {
  for (let node = el; node; node = node.parentElement) {
    const hex = rgbToHex(getComputedStyle(node).backgroundColor);
    if (hex) return hex;
  }
  return null;
}
