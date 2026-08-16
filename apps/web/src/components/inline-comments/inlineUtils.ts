import type { Thread } from '../../lib/api.js';
/** Duration of the ic-flash CSS keyframe in ms. Must stay in sync with `app.css`. */
export const COMMENT_FLASH_MS = 760;

/**
 * Outcome of a thread workflow action (accept / reject / resolve /
 * reopen / repair).
 *
 * The message travels back to the card rather than only to a toast so
 * the failure stays visible next to the button that caused it — a toast
 * is gone in seconds and says nothing about *which* proposal failed.
 */
export type ThreadActionResult = { ok: true } | { ok: false; message: string };

export function inlineAvatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return parts
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase();
}

export function inlineAvatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * Resolve a thread's proposal links against the threads currently on
 * screen. A target that is filtered out — resolved and hidden, say — is
 * simply absent, so the card shows nothing rather than a dead control.
 */
export function threadLinks(
  thread: Thread,
  byId: Map<string, Thread>,
): { answers: Thread[]; answeredBy: Thread[] } {
  return {
    answers: (thread.proposal?.answers_thread_ids ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is Thread => t !== undefined),
    answeredBy: thread.answered_by_thread_ids
      .map((id) => byId.get(id))
      .filter((t): t is Thread => t !== undefined),
  };
}

export function threadsById(threads: Thread[]): Map<string, Thread> {
  return new Map(threads.map((t) => [t.id, t]));
}

/**
 * Readout for the comment toolbars: how many threads there are, and —
 * once the reader has reached one — which of them they are standing on.
 *
 * `currentIndex` is zero-based, negative above the first thread. A lone
 * thread stays a plain count: "1 of 1" carries no information the
 * arrows don't already show by being dead.
 */
export function threadCountLabel(count: number, currentIndex = -1): string {
  const plain = `${count} ${count === 1 ? 'thread' : 'threads'}`;
  if (count < 2 || currentIndex < 0 || currentIndex >= count) return plain;
  return `${currentIndex + 1} of ${plain}`;
}
