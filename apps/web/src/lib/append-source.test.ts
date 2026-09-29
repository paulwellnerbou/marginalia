/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { appendSource } from './append-source.js';

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
