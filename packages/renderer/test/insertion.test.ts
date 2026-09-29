import { expect, test } from 'bun:test';
import { insertAfterBlock, insertBeforeBlock, trimBlankLines } from '../src/insertion.js';

test('trims blank lines but keeps the first line’s indentation', () => {
  expect(trimBlankLines('\n  \n    code\n\n \n')).toBe('    code');
  expect(trimBlankLines(' \n\n')).toBe('');
});

test('extends a block with one blank line before the insertion', () => {
  expect(insertAfterBlock('Last paragraph.', '\n## Two\n\n')).toBe('Last paragraph.\n\n## Two');
});

test('moves an AsciiDoc block’s trailing blank lines past the insertion', () => {
  expect(insertAfterBlock('Last paragraph.\n\n', '== Two')).toBe('Last paragraph.\n\n== Two\n\n');
});

test('puts the insertion before a block with one blank line between', () => {
  expect(insertBeforeBlock('## Zero\n\n', '## One\n')).toBe('## Zero\n\n## One\n');
});
