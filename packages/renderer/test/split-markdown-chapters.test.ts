import { describe, expect, test } from 'bun:test';
import { splitMarkdownChapters } from '../src/index.js';

describe('splitMarkdownChapters', () => {
  test('splits H2 chapters below an H1 book title and preserves the preamble', () => {
    const source = '# The Salt Road\n\nAn introduction.\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n';
    const chapters = splitMarkdownChapters(source);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
    expect(chapters[0]?.source).toStartWith('# The Salt Road');
    expect(chapters[1]?.source).toStartWith('## Two');
    expect(chapters.map((chapter) => chapter.source).join('')).toBe(source);
  });

  test('uses H1 chapters when frontmatter supplies the title', () => {
    const source = '---\ntitle: A Book\n---\n\n# One\n\nFirst.\n\n# Two\n\nSecond.\n';
    const chapters = splitMarkdownChapters(source);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['One', 'Two']);
    expect(chapters.map((chapter) => chapter.source).join('')).toBe(source);
  });

  test('falls back to a single lossless chapter without headings', () => {
    const source = 'Just a paragraph.\n';
    expect(splitMarkdownChapters(source)).toEqual([{ index: 1, title: null, source }]);
  });
});
