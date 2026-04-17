/**
 * A user is identified by a `clientId` (random, auto-generated on first
 * visit) and a `displayName` (prompted on first action). Both live in
 * localStorage; the server treats them as untrusted identity claims.
 */

const CLIENT_ID_KEY = 'marginalia.clientId';
const DISPLAY_NAME_KEY = 'marginalia.displayName';

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
 * Returns the current identity if both clientId and displayName are set.
 * Callers handle the null case with in-app UI — never a native prompt.
 */
export function loadIdentity(): Identity | null {
  const clientId = getClientId();
  const displayName = getDisplayName();
  if (!displayName) return null;
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
