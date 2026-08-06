import { ApiError } from './api.js';

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
    'This proposal no longer applies: the document changed where it edits. Update the proposal against the current text, or reject it.',
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
  'answers-thread-not-found': 'The comment this proposal answers no longer exists.',

  // Access and identity
  forbidden: 'You do not have permission to do that.',
  'forbidden-accepted': 'Accepted proposals can only be changed by an admin.',
  'identity-required': 'Please set your display name first.',
  'password-required': 'This document is password protected.',
  'wrong-password': 'That password was not accepted.',
  'password-protected': 'This document is password protected.',
  'admin-token-required': 'This action needs an admin invite link.',

  // Content
  'body-required': 'Write something first.',
  'empty-response': 'Write a reply or pick an action first.',
  'invalid-body': 'The server rejected that input.',
  'invalid-emoji': 'That is not a supported reaction.',
  'source-required': 'The document cannot be saved empty.',
  'not-latest': 'Someone else changed the document while you were editing. Reload and try again.',
  'not-found': 'That is gone — someone may have deleted it. Reload and try again.',
};

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const known = MESSAGES[err.code];
  if (known) return known;
  // 5xx without a mapped code is the server's fault, not the user's.
  if (err.status >= 500) return `${fallback} — the server reported an error (${err.code}).`;
  return `${fallback} (${err.status}: ${err.code})`;
}
