/**
 * Per-document invite token store.
 *
 * When the URL is `/d/:uid/:token` the client records the token in
 * localStorage (keyed by doc uid) and sends it on every request as the
 * `X-Marginalia-Invite` header. That invite tells the server who the user
 * is (display name) and what they can do (role). The URL itself is a
 * shareable capability.
 */

const PREFIX = 'marginalia.invite.';

export function saveInviteToken(uid: string, token: string): void {
  localStorage.setItem(PREFIX + uid, token);
}

export function loadInviteToken(uid: string): string | null {
  return localStorage.getItem(PREFIX + uid);
}

export function clearInviteToken(uid: string): void {
  localStorage.removeItem(PREFIX + uid);
}
