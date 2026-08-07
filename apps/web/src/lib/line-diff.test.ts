/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { type DiffLine, diffLines } from './line-diff.js';

test('highlights inline replacements inside paired remove/add lines', () => {
  const before = 'Das ist unsere klare Empfehlung: drastisch vereinfachte DSFA.';
  const after = 'Das ist unsere klare Empfehlung: deutlich vereinfachte DSFA.';

  const lines = diffLines(before, after);
  const removed = lines.find((line) => line.op === 'remove');
  const added = lines.find((line) => line.op === 'add');

  expect(removed?.segments).toEqual([
    { changed: false, text: 'Das ist unsere klare Empfehlung: ' },
    { changed: true, text: 'drastisch' },
    { changed: false, text: ' vereinfachte DSFA.' },
  ]);
  expect(added?.segments).toEqual([
    { changed: false, text: 'Das ist unsere klare Empfehlung: ' },
    { changed: true, text: 'deutlich' },
    { changed: false, text: ' vereinfachte DSFA.' },
  ]);
});

test('word-diffs a reworded paragraph against itself, not against one inserted above it', () => {
  const maeve = (opening: string) =>
    `${opening} in one hand, gloves shoved into it, fiery red hair already escaping whatever she tied it with that morning — a small, quick young woman, freckles across her nose and down both arms. She stops when she sees the open box, and for a moment she doesn't say anything at all — just looks.`;
  const riders =
    'Three riders pass the open box on their way down the aisle, helmets swinging, loud and happy with their ride, and not one of them looks in.';
  const before = ['Intro line.', '', maeve('Maeve is first through. Helmet'), '', 'Tail line.'];
  const after = [
    'Intro line.',
    '',
    riders,
    '',
    maeve('Maeve is next through — helmet'),
    '',
    'Tail line.',
  ];

  const lines = diffLines(before.join('\n'), after.join('\n'));
  const removed = lines.find((line) => line.op === 'remove');
  const inserted = lines.find((line) => line.op === 'add' && line.text === riders);
  const reworded = lines.find((line) => line.op === 'add' && line.text.startsWith('Maeve'));

  // The insertion is wholly new, so it carries no inline highlighting at all.
  expect(inserted?.segments).toBeUndefined();
  const changedWords = (line?: DiffLine) =>
    line?.segments?.filter((segment) => segment.changed).map((segment) => segment.text.trim());
  expect(changedWords(removed)).toEqual(['first', '.', 'Helmet']);
  expect(changedWords(reworded)).toEqual(['next', '—', 'helmet']);
});

// Which side of the blank line the diff puts the removal on is a coin toss
// between equally minimal edit scripts, so the pairing has to work either way.
test('word-diffs a rewrite that the diff separated from its original by a blank line', () => {
  const before = ['Head', 'The cold wakes him before the alarm does.', '', 'Tail'];
  const after = [
    'Head',
    'A new opening paragraph.',
    '',
    'The cold wakes him before dawn does.',
    'Tail',
  ];

  const lines = diffLines(before.join('\n'), after.join('\n'));
  const removed = lines.find((line) => line.op === 'remove');
  const rewrite = lines.find((line) => line.op === 'add' && line.text.startsWith('The cold'));

  const changedWords = (line?: DiffLine) =>
    line?.segments?.filter((segment) => segment.changed).map((segment) => segment.text.trim());
  expect(changedWords(removed)).toEqual(['the', 'alarm']);
  expect(changedWords(rewrite)).toEqual(['dawn']);
});

test('leaves a wholly rewritten line unpaired instead of matching stray words', () => {
  const before = 'Alpha keeps this part\nThe cold wakes him before the alarm does.';
  const after = 'Alpha keeps this part\nRain, and the smell of wet straw.';

  const lines = diffLines(before, after).filter((line) => line.op !== 'equal');

  expect(lines.map((line) => line.op)).toEqual(['remove', 'add']);
  expect(lines[0]?.segments).toBeUndefined();
  expect(lines[1]?.segments).toBeUndefined();
});

function markdownDoc(paragraphs: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 20 === 0) {
      lines.push(`## Chapter ${i / 20 + 1}`, '');
    }
    lines.push(`Paragraph ${i}: the cold wakes him before the alarm does.`, '');
  }
  return lines;
}

test('recognizes an insertion in a long document', () => {
  const before = markdownDoc(400);
  const after = [...before];
  after.splice(before.length / 2, 0, 'Inserted paragraph one.', '', 'Inserted paragraph two.', '');

  const lines = diffLines(before.join('\n'), after.join('\n'));

  expect(lines.filter((line) => line.op === 'remove')).toHaveLength(0);
  expect(lines.filter((line) => line.op === 'add').map((line) => line.text)).toEqual([
    'Inserted paragraph one.',
    '',
    'Inserted paragraph two.',
    '',
  ]);
  expect(lines.filter((line) => line.op === 'equal')).toHaveLength(before.length);
});

test('keeps a localized replacement minimal in a long document', () => {
  const before = markdownDoc(400);
  const after = [...before];
  const target = after.indexOf('Paragraph 200: the cold wakes him before the alarm does.');
  after[target] = 'Paragraph 200: rewritten entirely.';

  const lines = diffLines(before.join('\n'), after.join('\n'));

  expect(lines.filter((line) => line.op === 'remove').map((line) => line.text)).toEqual([
    'Paragraph 200: the cold wakes him before the alarm does.',
  ]);
  expect(lines.filter((line) => line.op === 'add').map((line) => line.text)).toEqual([
    'Paragraph 200: rewritten entirely.',
  ]);
});

// Edits at both ends leave nothing for the prefix/suffix trim to take off, so
// the whole document reaches the search. It used to give up there and walk both
// sides in lockstep, reporting every line below the first edit as changed.
test('stays minimal when a long document is edited at both ends', () => {
  const before = markdownDoc(400);
  const after = [...before];
  after[after.length - 2] = 'Paragraph 399: rewritten entirely.';
  after.splice(after.indexOf('Paragraph 10: the cold wakes him before the alarm does.') + 1, 1);
  expect(before.length).toBeGreaterThan(800);

  const lines = diffLines(before.join('\n'), after.join('\n'));

  expect(lines.filter((line) => line.op === 'remove').map((line) => line.text)).toEqual([
    '',
    'Paragraph 399: the cold wakes him before the alarm does.',
  ]);
  expect(lines.filter((line) => line.op === 'add').map((line) => line.text)).toEqual([
    'Paragraph 399: rewritten entirely.',
  ]);
});

test('leaves unrelated lines unpaired in a block too wide for the pairing table', () => {
  const before = Array.from({ length: 120 }, (_, i) => `Before line ${i} with its own wording.`);
  // Blanks sit at offsets the other side has prose at, so pairing by position —
  // all this block is wide enough for — lines them up against each other.
  const after = Array.from({ length: 120 }, (_, i) =>
    i % 2 === 0 ? `After line ${i} with different wording.` : '',
  );

  const lines = diffLines(before.join('\n'), after.join('\n'));
  const changed = lines.filter((line) => line.op !== 'equal');

  expect(changed).toHaveLength(240);
  expect(changed.filter((line) => !line.text && line.segments)).toEqual([]);
  const whollyHighlighted = changed.filter(
    (line) => line.segments?.length === 1 && line.segments[0]?.changed,
  );
  expect(whollyHighlighted).toEqual([]);
  // The prose lines that do sit opposite each other still word-diff.
  expect(changed.filter((line) => line.segments)).toHaveLength(120);
});

test('lists removals before additions within a changed block', () => {
  const before = ['Head', 'only in before', 'Tail'].join('\n');
  const after = ['Head', 'only in after', 'and one more', 'Tail'].join('\n');

  const lines = diffLines(before, after);

  expect(lines.map((line) => line.op)).toEqual(['equal', 'remove', 'add', 'add', 'equal']);
});

test('diffs identical documents as all-equal', () => {
  const doc = markdownDoc(400).join('\n');
  const lines = diffLines(doc, doc);
  expect(lines.every((line) => line.op === 'equal')).toBe(true);
});

test('pairs multi-line replacement blocks line-by-line for inline highlighting', () => {
  const before = ['Alpha keeps this part', 'Beta old value', 'Gamma old tail'].join('\n');
  const after = ['Alpha keeps this part', 'Beta new value', 'Gamma new tail'].join('\n');

  const lines = diffLines(before, after).filter((line) => line.op !== 'equal');

  expect(lines).toHaveLength(4);
  expect(lines[0]?.segments).toEqual([
    { changed: false, text: 'Beta ' },
    { changed: true, text: 'old' },
    { changed: false, text: ' value' },
  ]);
  expect(lines[1]?.segments).toEqual([
    { changed: false, text: 'Gamma ' },
    { changed: true, text: 'old' },
    { changed: false, text: ' tail' },
  ]);
  expect(lines[2]?.segments).toEqual([
    { changed: false, text: 'Beta ' },
    { changed: true, text: 'new' },
    { changed: false, text: ' value' },
  ]);
  expect(lines[3]?.segments).toEqual([
    { changed: false, text: 'Gamma ' },
    { changed: true, text: 'new' },
    { changed: false, text: ' tail' },
  ]);
});
