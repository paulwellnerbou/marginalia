import { describe, expect, test } from 'bun:test';
import type { TocNode } from './api.js';
import { anchorInChapter, chapterNodes, chapterOfSectionChain } from './chapter-reading.js';

function node(id: string, level: number, children: TocNode[] = []): TocNode {
  return { id, level, text: id, children };
}

describe('chapterNodes', () => {
  const book = [node('book', 1, [node('ch1', 2, [node('ch1-a', 3)]), node('ch2', 2)])];

  test('a lone book title over chapters is unwrapped', () => {
    expect(chapterNodes(book, {}).map((n) => n.id)).toEqual(['ch1', 'ch2']);
  });

  test('a frontmatter title means the top heading is a chapter of its own', () => {
    expect(chapterNodes(book, { title: 'Crestwood' }).map((n) => n.id)).toEqual(['book']);
  });

  test('several top-level headings are the chapters', () => {
    const toc = [node('a', 1, [node('a1', 2)]), node('b', 1)];
    expect(chapterNodes(toc, {}).map((n) => n.id)).toEqual(['a', 'b']);
  });

  test('a lone heading with nothing under it stays the one chapter', () => {
    expect(chapterNodes([node('only', 1)], {}).map((n) => n.id)).toEqual(['only']);
  });

  test('a lone h2 is not taken for a book title', () => {
    const toc = [node('part', 2, [node('x', 3), node('y', 3)])];
    expect(chapterNodes(toc, {}).map((n) => n.id)).toEqual(['part']);
  });
});

describe('chapterOfSectionChain', () => {
  const chapters = new Map([
    ['ch1', 0],
    ['ch2', 1],
  ]);

  test('a block reads in the chapter named in its heading chain', () => {
    expect(chapterOfSectionChain(['book', 'ch2', 'ch2-a'], chapters)).toBe(1);
  });

  test('preamble belongs to the first chapter', () => {
    expect(chapterOfSectionChain(['book'], chapters)).toBe(0);
    expect(chapterOfSectionChain([], chapters)).toBe(0);
  });
});

describe('anchorInChapter', () => {
  const chapters = new Map([
    ['ch1', 0],
    ['ch2', 1],
    ['ch3', 2],
  ]);
  const blocks = new Map<string, string[]>([
    ['intro', ['book']],
    ['p1', ['book', 'ch1']],
    ['p2', ['book', 'ch2']],
    ['p3', ['book', 'ch3']],
  ]);

  test('an anchor shows in the chapter its block reads in', () => {
    expect(anchorInChapter({ block_id: 'p2' }, blocks, chapters, 1)).toBe(true);
    expect(anchorInChapter({ block_id: 'p2' }, blocks, chapters, 0)).toBe(false);
  });

  test('a preamble anchor shows with the first chapter', () => {
    expect(anchorInChapter({ block_id: 'intro' }, blocks, chapters, 0)).toBe(true);
  });

  test('a span shows in the chapters at either end', () => {
    const span = { block_id: 'p1', end_block_id: 'p3' };
    expect(anchorInChapter(span, blocks, chapters, 0)).toBe(true);
    expect(anchorInChapter(span, blocks, chapters, 2)).toBe(true);
  });

  test('an anchor whose blocks are gone is not hidden by chapter', () => {
    expect(anchorInChapter({ block_id: 'deleted' }, blocks, chapters, 2)).toBe(true);
    expect(anchorInChapter({ block_id: null }, blocks, chapters, 2)).toBe(true);
  });
});
