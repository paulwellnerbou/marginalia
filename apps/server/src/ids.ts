import { randomBytes } from 'node:crypto';

/**
 * 22-character URL-safe document UID (128 bits of entropy, base64url).
 * Matches the "UID-similar URL" requirement from REQUIREMENTS §3.2.
 */
export function newDocumentUid(): string {
  return randomBytes(16).toString('base64url');
}

/** URL-safe invite token. 22 chars = 128 bits of entropy. Used as the
 *  path segment after the doc UID. */
export function newInviteToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Long session cookie token. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
