import { describe, expect, test } from 'bun:test';
import {
  type ConflictSegment,
  autoResolution,
  mergeThreeWay,
  parseConflictSegments,
  resolveSegments,
} from '../src/conflict.js';

const BASE = `# Title

Para A baseline.

Para B baseline.

Para C baseline.
`;

type ConflictHunk = Extract<ConflictSegment, { kind: 'conflict' }>;

function conflicts(segments: ConflictSegment[]): ConflictHunk[] {
  return segments.filter((s): s is ConflictHunk => s.kind === 'conflict');
}

function onlyConflict(segments: ConflictSegment[]): ConflictHunk {
  const hunks = conflicts(segments);
  expect(hunks).toHaveLength(1);
  const hunk = hunks[0];
  if (!hunk) throw new Error('expected exactly one conflict hunk');
  return hunk;
}

describe('mergeThreeWay', () => {
  test('merges edits to different paragraphs without a conflict', async () => {
    const current = BASE.replace('Para A baseline.', 'Para A edited by the document.');
    const proposed = BASE.replace('Para C baseline.', 'Para C edited by the proposal.');

    const merged = await mergeThreeWay({ current, base: BASE, proposed });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.text).toContain('Para A edited by the document.');
    expect(merged.text).toContain('Para C edited by the proposal.');
    expect(merged.text).toContain('Para B baseline.');
  });

  test('takes the proposal when the document never moved off base', async () => {
    const proposed = BASE.replace('Para B baseline.', 'Para B rewritten.');

    const merged = await mergeThreeWay({ current: BASE, base: BASE, proposed });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.text).toBe(proposed);
  });

  test('reports overlapping edits as a conflict with both sides', async () => {
    const current = BASE.replace('Para B baseline.', 'Para B as the document has it.');
    const proposed = BASE.replace('Para B baseline.', 'Para B as the proposal wants it.');

    const merged = await mergeThreeWay({ current, base: BASE, proposed });

    expect(merged.ok).toBe(false);
    if (merged.ok || merged.reason !== 'conflict') throw new Error('expected a conflict');
    const hunk = onlyConflict(merged.segments);
    expect(hunk.current).toBe('Para B as the document has it.\n');
    expect(hunk.base).toBe('Para B baseline.\n');
    expect(hunk.proposed).toBe('Para B as the proposal wants it.\n');
    expect(hunk.auto).toBeNull();
  });

  test('segments reassemble into each side of the conflict', async () => {
    const current = BASE.replace('Para B baseline.', 'Document version.');
    const proposed = BASE.replace('Para B baseline.', 'Proposal version.');

    const merged = await mergeThreeWay({ current, base: BASE, proposed });
    if (merged.ok || merged.reason !== 'conflict') throw new Error('expected a conflict');

    expect(resolveSegments(merged.segments, ['current'])).toBe(current);
    expect(resolveSegments(merged.segments, ['proposed'])).toBe(proposed);
    expect(resolveSegments(merged.segments, ['both'])).toContain('Document version.\nProposal');
  });

  test('a resolution can replace a hunk with text of its own', async () => {
    const current = BASE.replace('Para B baseline.', 'Document version.');
    const proposed = BASE.replace('Para B baseline.', 'Proposal version.');

    const merged = await mergeThreeWay({ current, base: BASE, proposed });
    if (merged.ok || merged.reason !== 'conflict') throw new Error('expected a conflict');

    expect(resolveSegments(merged.segments, ['Hand-written resolution.\n'])).toBe(
      BASE.replace('Para B baseline.', 'Hand-written resolution.'),
    );
  });

  test('a setext heading underline is not read as a separator', async () => {
    // Seven `=` is git's default separator and a valid Markdown h1 rule.
    const doc = `Chapter One\n=======\n\nBody paragraph.\n`;
    const current = doc.replace('Body paragraph.', 'Body as the document has it.');
    const proposed = doc.replace('Body paragraph.', 'Body as the proposal wants it.');

    const merged = await mergeThreeWay({ current, base: doc, proposed });
    if (merged.ok || merged.reason !== 'conflict') throw new Error('expected a conflict');

    expect(onlyConflict(merged.segments).current).toBe('Body as the document has it.\n');
    expect(resolveSegments(merged.segments, ['current'])).toBe(current);
  });

  test('preserves a missing trailing newline', async () => {
    const base = 'one\ntwo';
    const merged = await mergeThreeWay({ current: base, base, proposed: 'one\nTWO' });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.text).toBe('one\nTWO');
  });

  test('a conflict on an unterminated last line invents no newline', async () => {
    // Block ranges are sliced without their terminator, so every hunk a
    // single-paragraph proposal produces looks like this.
    const base = 'The middle paragraph.';
    const current = `${base} Alice adds an example.`;
    const proposed = `${base} Bob adds a caveat.`;

    const merged = await mergeThreeWay({ current, base, proposed });
    if (merged.ok || merged.reason !== 'conflict') throw new Error('expected a conflict');

    const hunk = onlyConflict(merged.segments);
    expect(hunk.current).toBe(current);
    expect(hunk.base).toBe(base);
    expect(hunk.proposed).toBe(proposed);
    expect(resolveSegments(merged.segments, ['current'])).toBe(current);
    expect(resolveSegments(merged.segments, ['proposed'])).toBe(proposed);
    expect(resolveSegments(merged.segments, ['both'])).toBe(`${current}\n${proposed}`);
  });
});

describe('autoResolution', () => {
  test('picks the side that moved when the other is still at base', () => {
    expect(autoResolution({ current: 'a\n', base: 'a\n', proposed: 'b\n' })).toBe('proposed');
    expect(autoResolution({ current: 'b\n', base: 'a\n', proposed: 'a\n' })).toBe('current');
  });

  test('settles sides that differ only in trailing whitespace', () => {
    expect(autoResolution({ current: 'same  \n', base: 'old\n', proposed: 'same\n' })).toBe(
      'current',
    );
  });

  test('leaves genuinely different edits to a human', () => {
    expect(autoResolution({ current: 'mine\n', base: 'old\n', proposed: 'yours\n' })).toBeNull();
  });

  test('does not treat indentation as noise', () => {
    // Leading whitespace changes list nesting and code blocks.
    expect(autoResolution({ current: '  item\n', base: 'x\n', proposed: 'item\n' })).toBeNull();
  });
});

describe('parseConflictSegments', () => {
  test('keeps text after an unterminated hunk', () => {
    const marked = `${'<'.repeat(21)} current\nhalf a hunk\ntail\n`;
    const segments = parseConflictSegments(marked);

    expect(conflicts(segments)).toHaveLength(0);
    expect(resolveSegments(segments, [])).toBe(marked);
  });

  test('reads consecutive hunks independently', () => {
    const m = (c: string) => c.repeat(21);
    const marked = [
      'head\n',
      `${m('<')} current\nA-doc\n${m('|')} base\nA-base\n${m('=')}\nA-prop\n${m('>')} proposed\n`,
      'middle\n',
      `${m('<')} current\nB-doc\n${m('|')} base\nB-base\n${m('=')}\nB-prop\n${m('>')} proposed\n`,
      'tail\n',
    ].join('');

    const segments = parseConflictSegments(marked);

    expect(conflicts(segments)).toHaveLength(2);
    expect(resolveSegments(segments, ['current', 'proposed'])).toBe(
      'head\nA-doc\nmiddle\nB-prop\ntail\n',
    );
  });
});
