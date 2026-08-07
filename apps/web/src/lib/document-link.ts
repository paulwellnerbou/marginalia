/**
 * Turning a pasted document link into a route.
 *
 * An installed PWA has its own storage on iOS — nothing the browser
 * claimed carries over — so pasting the original invite URL is how access
 * moves onto the app. The server keeps invite rows alive precisely so a
 * re-claim from "another browser" works (see claimInvite), which leaves
 * this with only one job: work out where the user meant to go.
 */

/** UIDs and invite tokens are both 22-char base64url. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Long enough that a stray word pasted into the field reads as a mistake
 * rather than a document that happens not to exist.
 */
const MIN_BARE_UID = 16;

export type ParsedDocumentLink =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'other-site'; host: string }
  | { ok: false; reason: 'unrecognized' };

/**
 * `currentHost` is passed in rather than read from `location` so this
 * stays a pure function.
 */
export function parseDocumentLink(input: string, currentHost: string): ParsedDocumentLink {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  let pathname: string;
  const url = asUrl(trimmed);
  if (url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'unrecognized' };
    }
    // Compared by host, not origin: a link copied as http:// from an
    // https:// deployment is still this deployment.
    if (url.host !== currentHost) return { ok: false, reason: 'other-site', host: url.host };
    pathname = url.pathname;
  } else if (trimmed.startsWith('/')) {
    pathname = trimmed;
  } else if (SEGMENT.test(trimmed) && trimmed.length >= MIN_BARE_UID) {
    pathname = `/d/${trimmed}`;
  } else {
    return { ok: false, reason: 'unrecognized' };
  }

  const path = normalizeDocPath(pathname);
  return path ? { ok: true, path } : { ok: false, reason: 'unrecognized' };
}

/** Absolute link that re-grants this device's access on another one. */
export function accessLinkFor(uid: string, token: string | null | undefined): string {
  const path = token ? `/d/${uid}/${token}` : `/d/${uid}`;
  return new URL(path, window.location.origin).href;
}

function asUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Accepts every shape the router serves — `/d/:uid`, `/d/:uid/:token`,
 * `/d/:uid/edit`, `/d/:uid/:token/edit` — and drops query, hash and
 * trailing slash. Resolving `edit`-vs-token stays with the router, which
 * already ranks the literal segment above the dynamic one.
 */
function normalizeDocPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'd') return null;

  const rest = parts.slice(1);
  if (rest.length === 0 || rest.length > 3) return null;
  if (!rest.every((part) => SEGMENT.test(part))) return null;
  if (rest.length === 3 && rest[2] !== 'edit') return null;

  return `/d/${rest.join('/')}`;
}
