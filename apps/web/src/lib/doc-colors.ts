import { type CSSProperties, useSyncExternalStore } from 'react';
import { useAppearance } from './appearance.js';

/**
 * The reader's own paper and ink, overriding the theme's
 * `--md-color-bg` / `--md-color-fg`. Kept per appearance, since a paper
 * picked for light mode is wrong in dark mode, and per browser, like the
 * other display settings, rather than per document or theme.
 */

export type DocColorRole = 'bg' | 'fg';
export type DocColorMode = 'light' | 'dark';
export type DocColors = Partial<Record<DocColorRole, string>>;
export type DocColorOverrides = Partial<Record<DocColorMode, DocColors>>;

const KEY = 'marginalia.docColors';
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

function load(): DocColorOverrides {
  try {
    return parseDocColors(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

let current: DocColorOverrides | null = null;
const listeners = new Set<() => void>();

function snapshot(): DocColorOverrides {
  current ??= load();
  return current;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  current = load();
  for (const l of listeners) l();
}

export function setDocColor(mode: DocColorMode, role: DocColorRole, value: string | null): void {
  current = withDocColor(snapshot(), mode, role, value);
  try {
    if (Object.keys(current).length > 0) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode / quota: the choice still holds for this page.
  }
  for (const l of listeners) l();
}

/** The overrides for the appearance the page is showing right now. */
export function useDocColors(): { mode: DocColorMode; colors: DocColors } {
  const { resolved } = useAppearance();
  const all = useSyncExternalStore(subscribe, snapshot);
  return { mode: resolved, colors: all[resolved] ?? {} };
}

/**
 * Inline, because every `.marginalia-theme` and `.marginalia` element
 * redeclares the theme's colors, so an override set only on an ancestor
 * would be shadowed one level down.
 */
export function docColorStyle(colors: DocColors): CSSProperties | undefined {
  if (!colors.bg && !colors.fg) return undefined;
  return {
    ...(colors.bg ? { ['--md-color-bg' as string]: colors.bg } : {}),
    ...(colors.fg ? { ['--md-color-fg' as string]: colors.fg } : {}),
  };
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
