import type { Thread } from '../../lib/api.js';
/** Duration of the ic-flash CSS keyframe in ms. Must stay in sync with `app.css`. */
export const COMMENT_FLASH_MS = 760;

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
): { answers: Thread | null; answeredBy: Thread[] } {
  const answersId = thread.proposal?.answers_thread_id ?? null;
  return {
    answers: answersId ? (byId.get(answersId) ?? null) : null,
    answeredBy: thread.answered_by_thread_ids
      .map((id) => byId.get(id))
      .filter((t): t is Thread => t !== undefined),
  };
}

export function threadsById(threads: Thread[]): Map<string, Thread> {
  return new Map(threads.map((t) => [t.id, t]));
}
