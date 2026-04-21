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
