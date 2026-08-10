import type { ConflictChoice, ConflictSegment } from './api.js';

/** One hunk's settlement: a side to take, or text the user wrote. */
export type HunkChoice = { kind: ConflictChoice } | { kind: 'custom'; text: string };

export type ConflictHunk = Extract<ConflictSegment, { kind: 'conflict' }>;

export function conflictHunks(segments: ConflictSegment[]): ConflictHunk[] {
  return segments.filter((s): s is ConflictHunk => s.kind === 'conflict');
}

/**
 * Starting choices: hunks the server could have settled on its own are
 * preselected, the rest start undecided.
 *
 * Undecided rather than defaulted on purpose. A default is a decision
 * made by whoever wrote the UI, and here the two plausible defaults —
 * keep the document, take the proposal — each silently discard somebody
 * else's writing. Making the button wait is the only honest option.
 */
export function initialChoices(segments: ConflictSegment[]): Array<HunkChoice | null> {
  return conflictHunks(segments).map((hunk) => (hunk.auto ? { kind: hunk.auto } : null));
}

export function textForChoice(hunk: ConflictHunk, choice: HunkChoice): string {
  if (choice.kind === 'custom') return choice.text;
  if (choice.kind === 'current') return hunk.current;
  if (choice.kind === 'proposed') return hunk.proposed;
  return joinSides(hunk.current, hunk.proposed);
}

/**
 * The document the choices add up to. Undecided hunks fall back to the
 * document's own text so the preview stays readable while the user works
 * through them — callers gate Apply on `allDecided`, so a fallback never
 * reaches the server.
 */
export function resolvedText(
  segments: ConflictSegment[],
  choices: ReadonlyArray<HunkChoice | null>,
): string {
  let index = 0;
  let out = '';
  for (const segment of segments) {
    if (segment.kind === 'stable') {
      out += segment.text;
      continue;
    }
    const choice = choices[index];
    index += 1;
    out += choice ? textForChoice(segment, choice) : segment.current;
  }
  return out;
}

export function allDecided(choices: ReadonlyArray<HunkChoice | null>): boolean {
  return choices.every((choice) => choice !== null);
}

export function undecidedCount(choices: ReadonlyArray<HunkChoice | null>): number {
  return choices.filter((choice) => choice === null).length;
}

/**
 * Keep both sides, document first, with the seam on a line break — the
 * last hunk of a block carries no trailing newline, and without this its
 * final line would weld onto the proposal's first.
 */
function joinSides(current: string, proposed: string): string {
  if (current === '') return proposed;
  if (proposed === '') return current;
  return current.endsWith('\n') ? current + proposed : `${current}\n${proposed}`;
}
