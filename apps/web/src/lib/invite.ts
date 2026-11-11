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

/**
 * A link opened from the address bar is claimed before the document is
 * loaded: a group link answers with a different token to keep, and a
 * load sent with the group token would be refused. `getDocument` waits
 * on this.
 */
const pending = new Map<string, Promise<unknown>>();

export function setPendingInviteClaim(uid: string, claim: Promise<unknown>): void {
  const settled = claim.then(
    () => undefined,
    () => undefined,
  );
  pending.set(uid, settled);
  void settled.then(() => {
    if (pending.get(uid) === settled) pending.delete(uid);
  });
}

export function pendingInviteClaim(uid: string): Promise<unknown> | undefined {
  return pending.get(uid);
}
