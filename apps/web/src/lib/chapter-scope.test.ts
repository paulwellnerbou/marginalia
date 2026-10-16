import { describe, expect, test } from 'bun:test';
import { locateBlocks } from '@marginalia/renderer/locate-block';
import {
  chapterCopyParam,
  chapterEditQuery,
  resolveChapterScopeFromBlocks,
} from './chapter-scope.js';

/** What the rendered document lists for `source`: each top-level block in order. */
function located(source: string) {
  const { occurrences } = locateBlocks(source);
  const blocks = [...occurrences.values()]
    .flat()
    .sort((a, b) => a.start - b.start)
    .map((o) => ({
      id: o.id,
      headingLevel: o.kind === 'heading' ? /^#+/.exec(source.slice(o.start))![0].length : null,
    }));
  const idOf = (text: string) => [...occurrences.values()].flat().find((o) => o.text === text)!.id;
  return { occurrences, blocks, idOf };
}

const source = '# One\n\nintro\n\n## Detail\n\nmore\n\n# Two\n\nend';

describe('resolveChapterScopeFromBlocks', () => {
  test('includes nested sections and stops before the next peer heading', () => {
    const { occurrences, blocks, idOf } = located(source);
    expect(resolveChapterScopeFromBlocks(source, occurrences, blocks, idOf('One'))).toEqual({
      headingBlockId: idOf('One'),
      headingCopy: 0,
      section: { heading_path: ['One'], section_index: 0, section_index_path: [0, 0] },
      endBlockId: idOf('more'),
      blockIds: ['One', 'intro', 'Detail', 'more'].map(idOf),
      title: 'One',
      start: 0,
      end: 29,
      source: '# One\n\nintro\n\n## Detail\n\nmore',
    });
  });

  test('runs the final chapter through its final block', () => {
    const { occurrences, blocks, idOf } = located(source);
    const scope = resolveChapterScopeFromBlocks(source, occurrences, blocks, idOf('Two'));
    expect(scope?.source).toBe('# Two\n\nend');
    expect(scope?.endBlockId).toBe(idOf('end'));
  });

  test('rejects a non-heading target', () => {
    const { occurrences, blocks, idOf } = located(source);
    expect(resolveChapterScopeFromBlocks(source, occurrences, blocks, idOf('intro'))).toBeNull();
  });

  test('two chapters with one title resolve to the copy asked for', () => {
    // A chapter inserted ahead of "Chapter 4" under the same name, each
    // ending on the same line: the heading and the last paragraph each
    // carry one id on two blocks.
    const book =
      '# Book\n\n## Chapter 4\n\nNew prose.\n\nThe end.\n\n## Chapter 4\n\nOld prose.\n\nThe end.\n';
    const { occurrences, blocks, idOf } = located(book);
    const heading = idOf('Chapter 4');

    const first = resolveChapterScopeFromBlocks(book, occurrences, blocks, heading, 0);
    expect(first?.source).toBe('## Chapter 4\n\nNew prose.\n\nThe end.');

    const second = resolveChapterScopeFromBlocks(book, occurrences, blocks, heading, 1);
    expect(second?.source).toBe('## Chapter 4\n\nOld prose.\n\nThe end.');
    expect(second?.headingCopy).toBe(1);
    expect(second?.section.heading_path).toEqual(['Book', 'Chapter 4']);
    // Its position within "Book › Chapter 4" counts on from the first
    // chapter's blocks, which is what tells the server the copies apart.
    expect(second?.section.section_index).toBe(3);

    expect(resolveChapterScopeFromBlocks(book, occurrences, blocks, heading, 2)).toBeNull();
  });
});

describe('chapter edit query', () => {
  test('names the copy only past the first', () => {
    expect(chapterEditQuery('abc', 0)).toBe('?chapter=abc');
    expect(chapterEditQuery('abc', 2)).toBe('?chapter=abc&copy=2');
  });

  test('reads anything but a non-negative integer as the first copy', () => {
    expect(chapterCopyParam(null)).toBe(0);
    expect(chapterCopyParam('2')).toBe(2);
    expect(chapterCopyParam('-1')).toBe(0);
    expect(chapterCopyParam('1.5')).toBe(0);
    expect(chapterCopyParam('x')).toBe(0);
  });
});
