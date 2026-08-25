import { type DiffLine, diffLines } from './line-diff.js';

export interface SplitDiff {
  /** The lines of `before`: the ones both sides share, and the ones only it has. */
  before: DiffLine[];
  /** The lines of `after`, likewise. */
  after: DiffLine[];
}

/**
 * The same diff a unified view renders, dealt back out into the two texts it
 * came from.
 *
 * A unified diff answers "what changed"; this answers it while each side is
 * still readable as itself, which is what a view that asks you to *pick* one
 * of them needs. Each list is the whole of its own text — joining either
 * one's `text` with newlines gives the input back — with `segments` carried
 * through, so a line paired with its rewrite can highlight the words that
 * differ rather than the paragraph they sit in.
 */
export function splitDiffSides(before: string, after: string): SplitDiff {
  const lines = diffLines(before, after);
  const out: SplitDiff = { before: [], after: [] };
  for (const line of lines) {
    if (line.op !== 'add') out.before.push(line);
    if (line.op !== 'remove') out.after.push(line);
  }
  return out;
}
