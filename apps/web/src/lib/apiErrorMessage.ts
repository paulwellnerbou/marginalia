import { ApiError, UNKNOWN_ERROR_CODE } from './api.js';
import { isTransientError } from './retry.js';

/**
 * Turns a thrown request failure into something a reader can act on.
 *
 * The server's error codes are stable identifiers, not prose — showing
 * `409: proposal-conflict` in the UI tells the user that something went
 * wrong and nothing about what to do next. Codes without an entry here
 * fall back to `${status}: ${code}`, which is still better than a
 * generic failure for anyone reporting a bug.
 */
const MESSAGES: Record<string, string> = {
  // Proposal workflow
  'proposal-conflict':
    'This proposal no longer applies: the document changed where it edits. Use “Resolve conflict” to settle it against the current text, or reject it.',
  'proposal-resolution-empty':
    'That resolution leaves the document exactly as it is, so there would be nothing to accept. Change it, or reject the proposal instead.',
  'proposal-orphaned':
    'The text this proposal was anchored to is gone. Try “Repair anchor”, or re-create the proposal against the current text.',
  'proposal-merge-unavailable':
    'The server could not run the merge it needs to apply this proposal. That is a server problem, not a problem with the proposal — try again later.',
  'proposal-storage-unavailable': 'The server could not save the proposal. Try again in a moment.',
  'proposal-repair-unavailable': 'This proposal’s anchor cannot be repaired automatically.',
  'proposal-update-unavailable':
    'This proposal is too old to update in place. Re-create it against the current text.',
  'proposal-already-merged': 'This proposal has already been applied to the document.',
  'proposal-diff-unavailable': 'The proposed change could not be read back from storage.',
  'proposal-required': 'That action only applies to proposals.',
  'proposal-forbidden': 'That action does not apply to proposals.',
  'proposal-text-required': 'A proposal needs some replacement text.',
  'proposal-text-too-long': 'That proposed change is too long.',
  'not-reopenable': 'This proposal can no longer be reopened — the document has moved on since.',
  'not-open': 'This thread is already resolved, accepted, or rejected.',
  'not-resolved': 'This thread is still open, so there is nothing to reopen.',
  'not-orphaned': 'This proposal’s anchor is intact, so there is nothing to repair.',
  'anchor-block-not-found': 'That part of the document no longer exists. Reload and try again.',
  'anchor-required': 'Select some text to anchor this to first.',
  'anchor-too-long': 'That selection is too long to anchor a comment to.',
  'answers-thread-not-found': 'A comment this proposal answers no longer exists.',
  'too-many-answered-threads': 'This proposal answers too many comments at once.',

  // Access and identity
  forbidden: 'You do not have permission to do that.',
  'forbidden-accepted': 'Accepted proposals can only be changed by an admin.',
  'identity-required': 'Please set your display name first.',
  'password-required': 'This document is password protected.',
  'invite-required':
    'This document is restricted to people with an access link. Ask the document’s owner for one.',
  'wrong-password': 'That password was not accepted.',
  'password-protected': 'This document is password protected.',
  'admin-token-required': 'This action needs an admin invite link.',

  // Content
  'body-required': 'Write something first.',
  'empty-response': 'Write a reply or pick an action first.',
  'invalid-body': 'The server rejected that input.',
  'invalid-emoji': 'That is not a supported reaction.',
  'source-required': 'The document cannot be saved empty.',
  'plain-edit-required':
    'Only plain document edits can be reverted here. Proposal changes must be undone through their proposal workflow.',
  'revert-conflict':
    'Git could not undo this edit cleanly because later changes overlap it. Review the diff and undo it manually.',
  'already-reverted': 'This edit no longer changes the current document.',
  'git-unavailable': 'The server cannot run Git right now. Try again later.',
  'not-latest': 'Someone else changed the document while you were editing. Reload and try again.',
  'not-found': 'That is gone — someone may have deleted it. Reload and try again.',
};

/**
 * Statuses the reverse proxy invents when it has no working server to
 * relay: the process died mid-request, is restarting, or refused the
 * connection. The observed trigger is a large export (a JSON bundle
 * carries the whole packed git history) allocating past the container's
 * memory limit and getting killed, so the wording points at size and at
 * retrying.
 *
 * Only consulted for a response that carried no code, because the server
 * uses these statuses too and means something specific by them: 503 is
 * `export-busy`, 504 is `export-timeout`. Reading those as "the server
 * stopped responding" would be wrong about the cause and would bury the
 * one word that says what to do differently.
 */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) {
    // Only a rejection tagged at the `fetch` call site — never a bug in
    // our own code that happens to throw the same `TypeError` shape.
    if (isTransientError(err)) {
      return `${fallback} — the connection to the server dropped. Check your network and try again.`;
    }
    return fallback;
  }
  const known = MESSAGES[err.code];
  if (known) return known;
  // No code means no JSON body to take one from, so the status is the
  // only thing left to describe the failure by. Printing the placeholder
  // itself would just show the reader the word "unknown".
  if (err.code === UNKNOWN_ERROR_CODE) {
    if (GATEWAY_STATUSES.has(err.status)) {
      return `${fallback} — the server stopped responding partway through. It may have restarted or run out of memory; large exports are the usual trigger. Try again in a moment, and tell the operator if it keeps failing.`;
    }
    return `${fallback} — the server returned HTTP ${err.status}.`;
  }
  // 5xx without a mapped code is the server's fault, not the user's.
  if (err.status >= 500) return `${fallback} — the server reported an error (${err.code}).`;
  return `${fallback} (${err.status}: ${err.code})`;
}
