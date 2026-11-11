import { ApiError, claimInvite } from './api.js';
import { loadInviteToken, saveInviteToken, setPendingInviteClaim } from './invite.js';
import { inviteFromKeyring } from './keyring.js';

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

/**
 * The code to explain when a group link handed out nothing, or null. A
 * dismissed password prompt is not the link's doing: the password message
 * says what is missing there.
 */
export function linkRefusal(outcome: InviteLinkOutcome | null): string | null {
  if (outcome?.kind !== 'refused' || outcome.code === 'password-required') return null;
  return outcome.code;
}

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
  const generation = (latest.get(uid) ?? 0) + 1;
  latest.set(uid, generation);
  const outcome = claimAndStore(uid, token, () => latest.get(uid) === generation);
  inFlight.set(key, outcome);
  void outcome.finally(() => inFlight.delete(key));
  setPendingInviteClaim(uid, outcome);
  return outcome;
}

const inFlight = new Map<string, Promise<InviteLinkOutcome>>();

/**
 * The newest link opened per document. Claims of two links for one
 * document can finish in either order, and only the one opened last may
 * store its token, or an earlier answer would overwrite the later link.
 */
const latest = new Map<string, number>();

async function claimAndStore(
  uid: string,
  token: string,
  isLatest: () => boolean,
): Promise<InviteLinkOutcome> {
  const store = (kept: string) => {
    if (isLatest()) saveInviteToken(uid, kept);
  };
  // The ring may hold this person's personal link from another device;
  // without it a group link would hand this device a second identity.
  const held = loadInviteToken(uid) ?? (await inviteFromKeyring(uid)).token;
  try {
    const claimed = await claimInvite(uid, token, held && held !== token ? held : null);
    if (claimed.token && claimed.token !== token) {
      store(claimed.token);
      return { kind: 'personal', token: claimed.token, reused: claimed.reused === true };
    }
  } catch (err) {
    if (err instanceof ApiError && REFUSALS.has(err.code)) {
      return { kind: 'refused', code: err.code };
    }
    // These two say the link is an ordinary credential that just cannot be
    // claimed into a session; it still works as the invite header.
    const usableAsHeader =
      err instanceof ApiError &&
      (err.code === 'admin-invite-not-claimable' || err.code === 'password-protected');
    // Any other failure (gone, a server error, no network) says nothing
    // about what the link is. It may be a group link, which opens nothing,
    // so it never replaces a link this browser already holds.
    if (!usableAsHeader && held) return { kind: 'plain' };
  }
  store(token);
  return { kind: 'plain' };
}
