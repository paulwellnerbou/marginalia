/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { splitDiffSides } from './split-diff.js';

/** Each side has to be the whole of its own text, or a pane built from it
 *  would show the reader something the document does not say. */
function reassembles(before: string, after: string) {
  const sides = splitDiffSides(before, after);
  expect(sides.before.map((line) => line.text).join('\n')).toBe(before);
  expect(sides.after.map((line) => line.text).join('\n')).toBe(after);
  return sides;
}

test('gives each side its own lines, in order', () => {
  const sides = reassembles('one\ntwo\nthree', 'one\ntwo and a half\nthree');

  expect(sides.before.map((line) => line.op)).toEqual(['equal', 'remove', 'equal']);
  expect(sides.after.map((line) => line.op)).toEqual(['equal', 'add', 'equal']);
});

test('carries the word-level segments of a reworded line onto both sides', () => {
  const sides = reassembles(
    'the story kept "for your first staff dinner. September."',
    'the story kept "for your first staff dinner. In September."',
  );

  expect(sides.before[0]?.segments).toEqual([
    { changed: false, text: 'the story kept "for your first staff dinner. September."' },
  ]);
  expect(sides.after[0]?.segments).toEqual([
    { changed: false, text: 'the story kept "for your first staff dinner. ' },
    { changed: true, text: 'In ' },
    { changed: false, text: 'September."' },
  ]);
});

test('leaves a line only one side has unpaired, so it tints whole', () => {
  const sides = reassembles('kept', 'kept\nand a wholly unrelated sentence');

  const added = sides.after.filter((line) => line.op === 'add');
  expect(added).toHaveLength(1);
  expect(added[0]?.segments).toBeUndefined();
});

test('reassembles when one side is empty', () => {
  const sides = reassembles('', 'something');

  expect(sides.before.map((line) => line.op)).toEqual(['remove']);
  expect(sides.after.map((line) => line.op)).toEqual(['add']);
});

test('reassembles when the two sides share nothing', () => {
  reassembles('alpha\nbravo', 'charlie\ndelta\necho');
});
