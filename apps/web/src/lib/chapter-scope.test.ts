import { describe, expect, test } from 'bun:test';
import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import { resolveChapterScopeFromBlocks } from './chapter-scope.js';

const source = '# One\n\nintro\n\n## Detail\n\nmore\n\n# Two\n\nend';
const ranges = new Map<string, BlockSourceRange>([
  ['one', { start: 0, end: 5, kind: 'heading', text: 'One' }],
  ['intro', { start: 7, end: 12, kind: 'paragraph', text: 'intro' }],
  ['detail', { start: 14, end: 23, kind: 'heading', text: 'Detail' }],
  ['more', { start: 25, end: 29, kind: 'paragraph', text: 'more' }],
  ['two', { start: 31, end: 36, kind: 'heading', text: 'Two' }],
  ['end', { start: 38, end: 41, kind: 'paragraph', text: 'end' }],
]);
const blocks = [
  { id: 'one', headingLevel: 1 },
  { id: 'intro', headingLevel: null },
  { id: 'detail', headingLevel: 2 },
  { id: 'more', headingLevel: null },
  { id: 'two', headingLevel: 1 },
  { id: 'end', headingLevel: null },
];

describe('resolveChapterScopeFromBlocks', () => {
  test('includes nested sections and stops before the next peer heading', () => {
    expect(resolveChapterScopeFromBlocks(source, ranges, blocks, 'one')).toEqual({
      headingBlockId: 'one',
      endBlockId: 'more',
      blockIds: ['one', 'intro', 'detail', 'more'],
      title: 'One',
      start: 0,
      end: 29,
      source: '# One\n\nintro\n\n## Detail\n\nmore',
    });
  });

  test('runs the final chapter through its final block', () => {
    const scope = resolveChapterScopeFromBlocks(source, ranges, blocks, 'two');
    expect(scope?.source).toBe('# Two\n\nend');
    expect(scope?.endBlockId).toBe('end');
  });

  test('rejects a non-heading target', () => {
    expect(resolveChapterScopeFromBlocks(source, ranges, blocks, 'intro')).toBeNull();
  });
});
