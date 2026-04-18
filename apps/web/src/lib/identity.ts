/**
 * A user is identified by a `clientId` (random, auto-generated on first
 * visit) and a `displayName` (generated on first use, user-editable
 * later). Both live in localStorage; the server treats them as untrusted
 * identity claims.
 */

import { useEffect, useState } from 'react';

const CLIENT_ID_KEY = 'marginalia.clientId';
const DISPLAY_NAME_KEY = 'marginalia.displayName';
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

/** Get or create a persistent clientId. */
export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = generateClientId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function getDisplayName(): string {
  const existing = normalizeDisplayName(localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  if (existing && !isLegacyDefaultDisplayName(existing)) {
    if (existing !== localStorage.getItem(DISPLAY_NAME_KEY)) {
      localStorage.setItem(DISPLAY_NAME_KEY, existing);
    }
    return existing;
  }

  const generated = generateDisplayName(getClientId());
  localStorage.setItem(DISPLAY_NAME_KEY, generated);
  return generated;
}

export function setDisplayName(name: string): void {
  const prev = localStorage.getItem(DISPLAY_NAME_KEY);
  const next = normalizeDisplayName(name) || generateDisplayName(getClientId());
  localStorage.setItem(DISPLAY_NAME_KEY, next);
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
    if (e.key === DISPLAY_NAME_KEY) fn(getDisplayName());
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
  const bytes = new Uint8Array(16);
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
