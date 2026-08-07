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

/**
 * Keyring bearer secret. 32 bytes rather than an invite's 16 because
 * one of these stands in for every invite token it holds — the blast
 * radius of a guess is the whole set, not one document.
 */
export function newKeyringToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Device-pairing code: 8 characters of the same unambiguous alphabet the
 * generated document passwords use (no I/O/0/1), grouped for reading
 * aloud. 40 bits, which is thin for a standing secret and ample for one
 * that is single-use and expires in minutes.
 *
 * Rejection-sampled rather than `byte % 32` — 256 is a multiple of 32 so
 * the modulo would in fact be uniform here, but that is a property of
 * the current alphabet length, and a future edit to the alphabet
 * shouldn't quietly bias the code.
 */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length);
  const chars: string[] = [];
  while (chars.length < 8) {
    for (const byte of randomBytes(8)) {
      if (byte >= limit) continue;
      chars.push(alphabet[byte % alphabet.length] as string);
      if (chars.length === 8) break;
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
