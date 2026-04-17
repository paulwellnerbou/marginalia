/**
 * A user is identified by a `clientId` (random, auto-generated on first
 * visit) and a `displayName` (prompted on first action). Both live in
 * localStorage; the server treats them as untrusted identity claims.
 */

const CLIENT_ID_KEY = 'markdowner.clientId';
const DISPLAY_NAME_KEY = 'markdowner.displayName';

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

export function getDisplayName(): string | null {
  return localStorage.getItem(DISPLAY_NAME_KEY);
}

export function setDisplayName(name: string): void {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}

/**
 * Ensure we have both a clientId and a displayName. If displayName isn't
 * set yet, prompts the user for one. Returns null if the user cancels.
 */
export function ensureIdentity(): Identity | null {
  const clientId = getClientId();
  let displayName = getDisplayName();
  if (!displayName) {
    const entered = window.prompt(
      'Choose a display name (shown on your edits and comments):',
      '',
    );
    if (!entered || !entered.trim()) return null;
    displayName = entered.trim().slice(0, 80);
    setDisplayName(displayName);
  }
  return { clientId, displayName };
}

function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
