import { ApiError } from './api.js';

/**
 * A rate-limited attempt has to read differently from a wrong code —
 * otherwise someone who mistyped twice is told to go generate a fresh
 * code on the other device, does, and finds that one rejected too.
 *
 * Shared so the two places a code can be typed — the panel on the home
 * page and the page the QR lands on — cannot drift apart on the one
 * distinction that decides what the user should do next.
 */
export function redeemErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return 'Too many attempts. Wait a few minutes, then create a fresh code on your other device and try again.';
  }
  return 'That code did not work. Codes expire after a few minutes and work only once — create a fresh one on your other device.';
}
