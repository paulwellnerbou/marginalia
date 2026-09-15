import { describe, expect, test } from 'bun:test';
import {
  computeDocumentStats,
  countSentences,
  countWords,
  render,
  renderAsciidoc,
} from '../src/index.js';

describe('countWords', () => {
  test('counts whitespace-delimited tokens that carry a letter or digit', () => {
    expect(countWords('Hello, world!')).toBe(2);
    expect(countWords('well-known e.g. 3.14 — ok')).toBe(4);
    expect(countWords("don't stop")).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords('— … ***')).toBe(0);
  });

  test('counts every Han or kana character as a word', () => {
    expect(countWords('日本語のテキスト')).toBe(8);
    expect(countWords('日本語 hello')).toBe(4);
  });
});

describe('countSentences', () => {
  test('splits on terminators followed by whitespace', () => {
    expect(countSentences('One. Two! Three?')).toBe(3);
    expect(countSentences('He said “Stop.” Then left.')).toBe(2);
    expect(countSentences('Pi is 3.14 and that is all.')).toBe(1);
  });

  test('counts an unterminated run and nothing for empty text', () => {
    expect(countSentences('No terminator')).toBe(1);
    expect(countSentences('')).toBe(0);
  });
});

const book = [
  '# The Salt Road',
  '',
  'An introduction of six words here.',
  '',
  '## One',
  '',
  'First chapter text. Two sentences here!',
  '',
  '### Detail',
  '',
  'Nested words.',
  '',
  '## Two',
  '',
  '```js',
  'const notCounted = true;',
  '```',
  '',
  'Second chapter.',
  '',
].join('\n');

describe('computeDocumentStats', () => {
  test('totals the prose of a rendered document and leaves code out', async () => {
    const stats = computeDocumentStats(await render(book));
    expect(stats.total).toEqual({
      words: 22,
      characters: 126 + 7,
      charactersNoSpaces: 112,
      sentences: 5,
      paragraphs: 4,
    });
    expect(stats.headings).toBe(4);
    expect(stats.codeBlocks).toBe(1);
  });

  test('rolls counts up through the heading tree by the anchors the TOC uses', async () => {
    const rendered = await render(book);
    const stats = computeDocumentStats(rendered);
    expect(rendered.blocks.filter((b) => b.kind === 'heading').map((b) => b.headingId)).toEqual([
      'the-salt-road',
      'one',
      'detail',
      'two',
    ]);

    const [title] = stats.sections;
    expect(title?.id).toBe('the-salt-road');
    expect(title?.words).toBe(22);
    expect(title?.children.map((s) => [s.id, s.words, s.sentences, s.paragraphs])).toEqual([
      ['one', 10, 3, 2],
      ['two', 3, 1, 1],
    ]);
    expect(title?.children[0]?.children.map((s) => [s.id, s.words])).toEqual([['detail', 3]]);
  });

  test('unwraps a lone book title so the chapters are the rows, with the rest as preamble', async () => {
    const stats = computeDocumentStats(await render(book));
    expect(stats.chapters.map((c) => [c.title, c.words])).toEqual([
      ['One', 10],
      ['Two', 3],
    ]);
    expect(stats.preamble.words).toBe(9);
    expect(stats.preamble.sentences).toBe(1);
    expect(stats.preamble.paragraphs).toBe(1);
  });

  test('keeps top-level headings as chapters when frontmatter names the title', async () => {
    const source = '---\ntitle: A Book\n---\n\n# One\n\nFirst.\n\n# Two\n\nSecond.\n';
    const stats = computeDocumentStats(await render(source));
    expect(stats.chapters.map((c) => [c.title, c.words])).toEqual([
      ['One', 2],
      ['Two', 2],
    ]);
    // The YAML block is metadata, not prose.
    expect(stats.total.words).toBe(4);
    expect(stats.preamble.words).toBe(0);
  });

  test('keeps sibling top-level headings as chapters', async () => {
    const stats = computeDocumentStats(await render('# One\n\nA.\n\n# Two\n\nB.\n'));
    expect(stats.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });

  test('has no chapters without headings, and everything is preamble', async () => {
    const stats = computeDocumentStats(await render('Just a paragraph.\n'));
    expect(stats.chapters).toEqual([]);
    expect(stats.total.words).toBe(3);
    expect(stats.preamble).toEqual(stats.total);
  });

  test('a heading inside a blockquote is a TOC entry but opens no section', async () => {
    const stats = computeDocumentStats(await render('# Top\n\n> ## Quoted\n>\n> Words here.\n'));
    expect(stats.headings).toBe(2);
    expect(stats.sections.map((s) => s.id)).toEqual(['top']);
    expect(stats.sections[0]?.words).toBe(4);
  });

  test('raw HTML counts its text, not its tags', async () => {
    const stats = computeDocumentStats(await render('<div>Tom &amp; Jerry <b>run</b></div>\n'));
    expect(stats.total.words).toBe(3);
  });

  test('attributes asciidoc sections through their generated ids', async () => {
    const source = [
      '= My Doc',
      '',
      'Intro line.',
      '',
      '== First',
      '',
      'Some text here.',
      '',
      '== Second',
      '',
      'More text.',
      '',
    ].join('\n');
    const rendered = await renderAsciidoc(source);
    const stats = computeDocumentStats(rendered);
    expect(stats.chapters.map((c) => [c.id, c.title, c.words])).toEqual([
      ['_first', 'First', 4],
      ['_second', 'Second', 3],
    ]);
    expect(stats.preamble.words).toBe(2);
  });
});
