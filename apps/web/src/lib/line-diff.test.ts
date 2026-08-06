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

test('recognizes an insertion in a document too large for the LCS table', () => {
  const before = markdownDoc(400);
  const after = [...before];
  after.splice(before.length / 2, 0, 'Inserted paragraph one.', '', 'Inserted paragraph two.', '');
  expect((before.length + 1) * (after.length + 1)).toBeGreaterThan(500_000);

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

test('keeps a localized replacement minimal in a document too large for the LCS table', () => {
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
