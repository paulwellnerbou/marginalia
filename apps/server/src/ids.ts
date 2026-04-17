import { randomBytes } from 'node:crypto';

/**
 * 22-character URL-safe document UID (128 bits of entropy, base64url).
 * Matches the "UID-similar URL" requirement from REQUIREMENTS §3.2.
 */
export function newDocumentUid(): string {
  return randomBytes(16).toString('base64url');
}

/** 32-char recovery token returned once on upload. */
export function newRecoveryToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Long session cookie token. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
