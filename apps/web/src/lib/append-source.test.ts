/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { appendSource, appendToBlock, firstBlockFrom, lastBlock } from './append-source.js';

test('puts a blank line between the document and the addition', () => {
  expect(appendSource('# Story\n\nText.\n', '## Two\n')).toBe('# Story\n\nText.\n\n## Two\n');
  expect(appendSource('# Story\n\nText.', '## Two')).toBe('# Story\n\nText.\n\n## Two\n');
  expect(appendSource('# Story\n\nText.\n\n', '## Two')).toBe('# Story\n\nText.\n\n## Two\n');
});

test('leaves the existing text untouched', () => {
  const source = '# Story\n\nText.  \n\n\n';
  expect(appendSource(source, 'More.').startsWith(source)).toBe(true);
});

test('drops blank lines around the addition but keeps its indentation', () => {
  expect(appendSource('Text.\n', '\n\n    code\n\n\n')).toBe('Text.\n\n    code\n');
});

test('adds nothing for a blank addition', () => {
  expect(appendSource('Text.\n', '  \n\n')).toBe('Text.\n');
});

test('an empty document becomes the addition', () => {
  expect(appendSource('', '# Story')).toBe('# Story\n');
});

test('extends a block with one blank line before the addition', () => {
  expect(appendToBlock('Last paragraph.', '\n## Two\n\n')).toBe('Last paragraph.\n\n## Two');
});

test('moves an AsciiDoc block’s trailing blank lines past the addition', () => {
  expect(appendToBlock('Last paragraph.\n\n', '== Two')).toBe('Last paragraph.\n\n== Two\n\n');
});

const ranges = new Map([
  ['intro', { start: 0, end: 10 }],
  ['list', { start: 12, end: 40 }],
  ['item-1', { start: 12, end: 25 }],
  ['item-2', { start: 26, end: 40 }],
]);

test('the last block is the list, not its last item', () => {
  expect(lastBlock(ranges)?.[0]).toBe('list');
  expect(lastBlock(new Map())).toBeNull();
});

test('the first block from an offset is the outermost one starting there', () => {
  expect(firstBlockFrom(ranges, 11)).toBe('list');
  expect(firstBlockFrom(ranges, 26)).toBe('item-2');
  expect(firstBlockFrom(ranges, 41)).toBeNull();
});
