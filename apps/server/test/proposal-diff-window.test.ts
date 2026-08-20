import { describe, expect, test } from 'bun:test';
import { windowProposalDiff } from '../src/routes/edit-proposals.js';

/**
 * Narrowing a proposal's diff to the block it changes.
 *
 * The endpoint used to send two whole documents to show one changed
 * paragraph — 453 KB each in the case that prompted this. The window has
 * to keep everything the review dialog can render while refusing to
 * narrow anything it cannot prove is safe.
 */

/** A document with `n` numbered paragraphs, one per line. */
function doc(n: number, edit?: { line: number; text: string }): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(edit && edit.line === i ? edit.text : `Paragraph ${i}.`);
  }
  return lines.join('\n');
}

/** Offsets of `line` within `source`, as the proposal row stores them. */
function rangeOfLine(source: string, line: number): { start: number; end: number } {
  const lines = source.split('\n');
  const start = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  return { start, end: start + (lines[line]?.length ?? 0) };
}

describe('windowProposalDiff', () => {
  test('keeps only the changed block and its context', () => {
    const before = doc(500);
    const after = doc(500, { line: 250, text: 'Paragraph 250, revised.' });

    const win = windowProposalDiff({ before, after }, rangeOfLine(before, 250), 3);

    expect(win.before.split('\n')).toHaveLength(7);
    expect(win.after.split('\n')).toHaveLength(7);
    expect(win.before).toContain('Paragraph 250.');
    expect(win.after).toContain('Paragraph 250, revised.');
    // Three lines either side, and nothing beyond them.
    expect(win.before).toContain('Paragraph 247.');
    expect(win.before).not.toContain('Paragraph 246.');
  });

  test('the window is the same size however long the document is', () => {
    // This is the property that matters: the payload stops tracking the
    // document. A book-length review costs the same as a short one.
    const small = doc(200);
    const large = doc(5000);
    const winSmall = windowProposalDiff(
      { before: small, after: doc(200, { line: 100, text: 'Revised.' }) },
      rangeOfLine(small, 100),
      40,
    );
    const winLarge = windowProposalDiff(
      { before: large, after: doc(5000, { line: 2500, text: 'Revised.' }) },
      rangeOfLine(large, 2500),
      40,
    );

    expect(winLarge.before.split('\n')).toHaveLength(81);
    expect(winSmall.before.split('\n')).toHaveLength(81);
    // A 25x longer document, and the same payload.
    expect(winLarge.before.length).toBeLessThan(large.length / 20);
  });

  test('the windowed pair still diffs to the same single change', () => {
    const before = doc(500);
    const after = doc(500, { line: 250, text: 'Paragraph 250, revised.' });
    const win = windowProposalDiff({ before, after }, rangeOfLine(before, 250), 40);

    const b = win.before.split('\n');
    const a = win.after.split('\n');
    const differing = b.filter((line, i) => line !== a[i]);
    expect(differing).toEqual(['Paragraph 250.']);
  });

  test('follows the shift when the block gains lines', () => {
    const before = doc(500);
    const after = doc(500, { line: 250, text: 'First added line.\nSecond added line.' });

    const win = windowProposalDiff({ before, after }, rangeOfLine(before, 250), 3);

    expect(win.after).toContain('First added line.');
    expect(win.after).toContain('Second added line.');
    // The trailing context is the same lines on both sides, so the diff
    // does not spuriously show the tail as changed.
    expect(win.before.endsWith('Paragraph 253.')).toBe(true);
    expect(win.after.endsWith('Paragraph 253.')).toBe(true);
  });

  test('refuses to narrow when something outside the block also changed', () => {
    // A rebased or hand-edited branch: the row still points at one block,
    // but the texts differ elsewhere. Narrowing would hide that.
    const before = doc(500);
    const after = doc(500, { line: 250, text: 'Paragraph 250, revised.' }).replace(
      'Paragraph 10.',
      'Paragraph 10, also changed.',
    );

    const win = windowProposalDiff({ before, after }, rangeOfLine(before, 250), 3);

    expect(win.before).toBe(before);
    expect(win.after).toBe(after);
    expect(win.lineOffset).toBe(0);
  });

  test('leaves the pair alone when the range is nonsense', () => {
    const before = doc(50);
    const after = doc(50, { line: 10, text: 'Changed.' });

    const untouched = { before, after, lineOffset: 0 };
    expect(windowProposalDiff({ before, after }, { start: -1, end: 5 })).toEqual(untouched);
    expect(windowProposalDiff({ before, after }, { start: 10, end: 5 })).toEqual(untouched);
    expect(windowProposalDiff({ before, after }, { start: 0, end: before.length + 100 })).toEqual(
      untouched,
    );
  });

  test('reports where the window starts, so line numbers stay absolute', () => {
    // The dialog shows real line numbers. Without the offset it would
    // label the window's first line as line 1 and misplace the change by
    // thousands of lines.
    const before = doc(500);
    const after = doc(500, { line: 250, text: 'Paragraph 250, revised.' });

    const win = windowProposalDiff({ before, after }, rangeOfLine(before, 250), 12);

    expect(win.lineOffset).toBe(238);
    expect(win.before.split('\n')[0]).toBe('Paragraph 238.');
  });

  test('an unwindowed pair starts at the top', () => {
    const before = doc(20);
    const after = doc(20, { line: 5, text: 'Changed.' });

    // Context reaches past both ends, so the window is the whole document
    // and the numbering is unchanged.
    expect(windowProposalDiff({ before, after }, rangeOfLine(before, 5), 40).lineOffset).toBe(0);
  });

  test('a block near the start or end does not run off the document', () => {
    const before = doc(20);
    const first = windowProposalDiff(
      { before, after: doc(20, { line: 0, text: 'Changed first.' }) },
      rangeOfLine(before, 0),
      40,
    );
    const last = windowProposalDiff(
      { before, after: doc(20, { line: 19, text: 'Changed last.' }) },
      rangeOfLine(before, 19),
      40,
    );

    // The context reaches past both ends, so the whole document is the
    // window — correct, and still exactly what the reviewer should see.
    expect(first.before).toBe(before);
    expect(last.after).toContain('Changed last.');
  });
});
