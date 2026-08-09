import { describe, expect, test } from 'bun:test';
import type { ConflictChoice, ConflictSegment } from './api.js';
import {
  allDecided,
  conflictHunks,
  type HunkChoice,
  initialChoices,
  resolvedText,
  textForChoice,
  undecidedCount,
} from './conflict-resolution.js';

function hunk(
  current: string,
  base: string,
  proposed: string,
  auto: ConflictChoice | null = null,
): ConflictSegment {
  return { kind: 'conflict', current, base, proposed, auto };
}

const SEGMENTS: ConflictSegment[] = [
  { kind: 'stable', text: 'Opening line.\n' },
  hunk('Document wording.\n', 'Base wording.\n', 'Proposal wording.\n'),
  { kind: 'stable', text: 'Closing line.' },
];

describe('resolvedText', () => {
  test('assembles the document from one choice per hunk', () => {
    expect(resolvedText(SEGMENTS, [{ kind: 'current' }])).toBe(
      'Opening line.\nDocument wording.\nClosing line.',
    );
    expect(resolvedText(SEGMENTS, [{ kind: 'proposed' }])).toBe(
      'Opening line.\nProposal wording.\nClosing line.',
    );
  });

  test('keeps both sides in document-then-proposal order', () => {
    expect(resolvedText(SEGMENTS, [{ kind: 'both' }])).toBe(
      'Opening line.\nDocument wording.\nProposal wording.\nClosing line.',
    );
  });

  test('takes hand-written text verbatim', () => {
    expect(resolvedText(SEGMENTS, [{ kind: 'custom', text: 'Ours and theirs, merged.\n' }])).toBe(
      'Opening line.\nOurs and theirs, merged.\nClosing line.',
    );
  });

  test('previews an undecided hunk as the document already reads', () => {
    expect(resolvedText(SEGMENTS, [null])).toBe('Opening line.\nDocument wording.\nClosing line.');
  });

  test('settles each hunk independently', () => {
    const segments: ConflictSegment[] = [
      hunk('A-doc\n', 'A-base\n', 'A-prop\n'),
      { kind: 'stable', text: 'between\n' },
      hunk('B-doc', 'B-base', 'B-prop'),
    ];

    expect(resolvedText(segments, [{ kind: 'proposed' }, { kind: 'current' }])).toBe(
      'A-prop\nbetween\nB-doc',
    );
  });
});

describe('textForChoice', () => {
  test('welds an unterminated document side onto its own line', () => {
    const unterminated = hunk('Document.', 'Base.', 'Proposal.');
    if (unterminated.kind !== 'conflict') throw new Error('unreachable');

    expect(textForChoice(unterminated, { kind: 'both' })).toBe('Document.\nProposal.');
  });

  test('keeping both when one side is empty yields only the other', () => {
    const deletion = hunk('', 'Base.', 'Proposal.');
    if (deletion.kind !== 'conflict') throw new Error('unreachable');

    expect(textForChoice(deletion, { kind: 'both' })).toBe('Proposal.');
  });
});

describe('initialChoices', () => {
  test('preselects hunks the server could settle and leaves the rest open', () => {
    const segments: ConflictSegment[] = [
      hunk('A-doc\n', 'A-base\n', 'A-prop\n', 'proposed'),
      hunk('B-doc\n', 'B-base\n', 'B-prop\n'),
    ];

    const choices = initialChoices(segments);

    expect(choices).toEqual([{ kind: 'proposed' }, null]);
    expect(allDecided(choices)).toBe(false);
    expect(undecidedCount(choices)).toBe(1);
  });

  test('counts only conflicts, not the stable text around them', () => {
    expect(conflictHunks(SEGMENTS)).toHaveLength(1);
    expect(initialChoices(SEGMENTS)).toHaveLength(1);
  });

  test('a fully auto-resolvable set is ready to apply', () => {
    const choices: Array<HunkChoice | null> = initialChoices([
      hunk('A-doc\n', 'A-doc\n', 'A-prop\n', 'proposed'),
    ]);

    expect(allDecided(choices)).toBe(true);
  });
});
