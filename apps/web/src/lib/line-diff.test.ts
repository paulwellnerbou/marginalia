/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { diffLines } from './line-diff.js';

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
