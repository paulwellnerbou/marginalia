import { normalizeBaseUrl } from './config.js';

export interface DocumentRef {
  baseUrl: string;
  uid: string;
  /** Invite token from the URL, one remembered earlier, or the connection default. */
  token: string | null;
  /**
   * Comment named by a `#comment-<id>` fragment, if the caller pasted a
   * link to one. The viewer's "copy link to this comment" produces these,
   * so a user handing one over means "this thread" — and the id may
   * belong to a reply rather than the thread's opener.
   */
  commentId?: string | null;
}

export class DocumentRefError extends Error {}

/**
 * Document uids and invite tokens are both 22-character base64url
 * strings (16 random bytes). The pattern is deliberately loose on
 * length so a future id-size change doesn't lock this parser out.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

interface ParsedRef {
  baseUrl: string | null;
  uid: string;
  token: string | null;
  commentId: string | null;
}

/**
 * Accepts any of the shapes a user is likely to paste:
 *
 *   https://host/d/<uid>                     viewer link
 *   https://host/d/<uid>/<token>             shareable invite link
 *   https://host/d/<uid>/<token>/edit        editor link
 *   https://host/api/documents/<uid>/…       an API path
 *   <uid>                                    bare id
 *   <uid>/<token>                            bare id plus token
 */
export function parseDocumentRef(raw: string): ParsedRef {
  const input = raw.trim();
  if (!input) throw new DocumentRefError('No document was given.');

  if (/^https?:\/\//i.test(input)) return parseUrlRef(input);
  // A bare `host/d/<uid>` (no scheme) is common when copying from a URL
  // bar that hides the scheme. Only treat it as a URL if it has a path,
  // so a bare uid is never mistaken for a hostname.
  if (input.includes('/') && !ID_PATTERN.test(input.split('/')[0] ?? '')) {
    return parseUrlRef(`https://${input}`);
  }

  const [uid, token] = input.split('/');
  if (!uid || !ID_PATTERN.test(uid)) {
    throw new DocumentRefError(
      `"${raw}" is not a Marginalia document. Pass the document URL (https://<host>/d/<uid>/<token>) or its uid.`,
    );
  }
  return {
    baseUrl: null,
    uid,
    token: token && ID_PATTERN.test(token) ? token : null,
    commentId: null,
  };
}

function parseUrlRef(input: string): ParsedRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DocumentRefError(`"${input}" is not a valid URL.`);
  }

  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent);
  const docIndex = segments.indexOf('d');
  const apiIndex = segments.indexOf('documents');

  let uid: string | undefined;
  let token: string | null = null;
  if (docIndex >= 0) {
    uid = segments[docIndex + 1];
    const next = segments[docIndex + 2];
    // `/d/<uid>/edit` has no token — the third segment is the sub-route.
    if (next && next !== 'edit' && ID_PATTERN.test(next)) token = next;
  } else if (apiIndex >= 0) {
    uid = segments[apiIndex + 1];
  } else {
    uid = segments[segments.length - 1];
  }

  if (!uid || !ID_PATTERN.test(uid)) {
    throw new DocumentRefError(
      `Could not find a document id in "${input}". Expected a link like https://<host>/d/<uid>/<token>.`,
    );
  }
  // A token may also travel as `?invite=` on links produced by copy helpers.
  const queryToken = url.searchParams.get('invite');
  if (!token && queryToken && ID_PATTERN.test(queryToken)) token = queryToken;

  return { baseUrl: normalizeBaseUrl(url.origin), uid, token, commentId: readCommentId(url) };
}

const COMMENT_FRAGMENT = '#comment-';

/**
 * `#comment-<id>` as produced by the viewer's copy-link button.
 *
 * Held to the same shape as uids and tokens. The value reaches the
 * line-oriented text the tools emit, so anything else — a stray word, or
 * a control character smuggled in percent-encoded — would corrupt it;
 * and a malformed escape makes `decodeURIComponent` throw, which would
 * surface as an unexpected failure rather than "that isn't a comment
 * link". Anything unrecognized is simply not a comment link.
 */
function readCommentId(url: URL): string | null {
  if (!url.hash.startsWith(COMMENT_FRAGMENT)) return null;
  const raw = url.hash.slice(COMMENT_FRAGMENT.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ID_PATTERN.test(decoded) ? decoded : null;
}

/** Reject hosts outside `allowedHosts` when the operator configured an allowlist. */
export function assertHostAllowed(baseUrl: string, allowedHosts: string[]): void {
  if (allowedHosts.length === 0) return;
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (allowedHosts.includes(host)) return;
  throw new DocumentRefError(
    `Host "${host}" is not in MARGINALIA_ALLOWED_HOSTS (${allowedHosts.join(', ')}).`,
  );
}

/** The canonical viewer link for a document, with the invite token when known. */
export function documentUrl(ref: DocumentRef): string {
  return ref.token ? `${ref.baseUrl}/d/${ref.uid}/${ref.token}` : `${ref.baseUrl}/d/${ref.uid}`;
}

/** The viewer link without the invite token — safe to hand to people. */
export function viewerUrl(ref: DocumentRef): string {
  return `${ref.baseUrl}/d/${ref.uid}`;
}

/**
 * Deep link to one message in a thread — the same URL the viewer's own
 * "copy link" button produces. Deliberately token-free: opening
 * /d/<uid>/<token> claims that invite, so a link carrying this agent's
 * token would hand the agent's identity and access to whoever clicks it.
 * Readers open the thread with whatever access they already have.
 */
export function commentUrl(ref: DocumentRef, commentId: string): string {
  return `${viewerUrl(ref)}#comment-${commentId}`;
}
