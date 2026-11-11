import { ApiError, claimInvite } from './api.js';
import { loadInviteToken, saveInviteToken, setPendingInviteClaim } from './invite.js';

/**
 * What opening a link from the address bar came to.
 *
 * - `plain`: an ordinary link, kept as it is.
 * - `personal`: a group link; `token` is the personal link this browser
 *   now keeps (a fresh one, or the one it already held when `reused`).
 * - `refused`: a group link that handed out nothing — off, full, or
 *   asked too often. Whatever this browser held is left in place.
 */
export type InviteLinkOutcome =
  | { kind: 'plain' }
  | { kind: 'personal'; token: string; reused: boolean }
  | { kind: 'refused'; code: string };

const REFUSALS = new Set([
  'group-link-off',
  'group-link-full',
  'too-many-requests',
  // The password prompt was dismissed; the group token is still worth nothing.
  'password-required',
]);

/**
 * Claim the link, then keep the token the claim says to keep. The group
 * token itself is never stored: it opens nothing, and storing it would
 * push the personal link this browser holds out of its slot.
 */
export function openInviteLink(uid: string, token: string): Promise<InviteLinkOutcome> {
  // One claim per link at a time. A second one started before the first
  // stored its answer would hold nothing yet and mint a second personal
  // link — React runs mount effects twice in development, and a reload
  // mid-claim does the same.
  const key = `${uid}/${token}`;
  const running = inFlight.get(key);
  if (running) return running;
  const held = loadInviteToken(uid);
  const outcome = claimAndStore(uid, token, held && held !== token ? held : null);
  inFlight.set(key, outcome);
  void outcome.finally(() => inFlight.delete(key));
  setPendingInviteClaim(uid, outcome);
  return outcome;
}

const inFlight = new Map<string, Promise<InviteLinkOutcome>>();

async function claimAndStore(
  uid: string,
  token: string,
  held: string | null,
): Promise<InviteLinkOutcome> {
  try {
    const claimed = await claimInvite(uid, token, held);
    if (claimed.token && claimed.token !== token) {
      saveInviteToken(uid, claimed.token);
      return { kind: 'personal', token: claimed.token, reused: claimed.reused === true };
    }
  } catch (err) {
    if (err instanceof ApiError && REFUSALS.has(err.code)) {
      return { kind: 'refused', code: err.code };
    }
    // 400 (admin invite), 409 (password-protected), 404 (invite gone):
    // fall back to invite-header auth via the token in localStorage.
  }
  saveInviteToken(uid, token);
  return { kind: 'plain' };
}
