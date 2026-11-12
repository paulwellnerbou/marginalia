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

describe('computeDocumentStats with splitAtBreaks', () => {
  const novel = [
    '# One',
    '',
    'The first scene opens here and keeps going for a while.',
    '',
    '---',
    '',
    'Second scene.',
    '',
    '* * *',
    '',
    'Third scene.',
    '',
    '# Two',
    '',
    'No breaks here.',
    '',
  ].join('\n');

  test('leaves separators alone unless asked, but counts them', async () => {
    const stats = computeDocumentStats(await render(novel));
    expect(stats.separators).toBe(2);
    expect(stats.chapters.map((c) => c.children.length)).toEqual([0, 0]);
  });

  test('splits a section into one child per run between separators', async () => {
    const rendered = await render(novel);
    const stats = computeDocumentStats(rendered, { splitAtBreaks: true });
    const [one, two] = stats.chapters;
    expect(one?.words).toBe(16);
    expect(
      one?.children.map((c) => [c.title, c.words, c.level, c.break?.index, c.break?.separator]),
    ).toEqual([
      ['The first scene opens here and keeps going…', 11, 2, 1, null],
      ['Second scene.', 2, 2, 2, 1],
      ['Third scene.', 2, 2, 3, 2],
    ]);
    expect(new Set(one?.children.map((c) => c.id)).size).toBe(3);
    expect(two?.children).toEqual([]);
    expect(stats.total.words).toBe(20);
  });

  test('makes the runs the rows of a document without headings', async () => {
    const source = 'Before the break.\n\n---\n\nAfter it.\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    expect(stats.chapters.map((c) => [c.title, c.words])).toEqual([
      ['Before the break.', 3],
      ['After it.', 2],
    ]);
    expect(stats.preamble.words).toBe(0);
  });

  test('keeps runs ahead of the chapters a lone title unwraps to', async () => {
    const source = 'Opening.\n\n---\n\nMore.\n\n# Book\n\n## Ch\n\nText.\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    expect(stats.chapters.map((c) => c.title)).toEqual(['Opening.', 'More.', 'Ch']);
  });

  test('ignores separators that leave fewer than two runs with text', async () => {
    const source = '# One\n\n---\n\nOnly text.\n\n---\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    expect(stats.sections[0]?.children).toEqual([]);
    expect(stats.chapters.map((c) => c.title)).toEqual(['One']);
  });

  test('drops the empty run a separator right below the heading leaves', async () => {
    const source = '# One\n\n---\n\nA.\n\n---\n\nB.\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    expect(stats.sections[0]?.children.map((c) => [c.title, c.break?.index])).toEqual([
      ['A.', 1],
      ['B.', 2],
    ]);
    // Numbered as the page numbers them, the dropped one included.
    expect(stats.sections[0]?.children.map((c) => c.break?.separator)).toEqual([1, 2]);
  });

  test('splits only the section a separator sits in, ahead of its subsections', async () => {
    const source = '# One\n\nA.\n\n---\n\nB.\n\n## Sub\n\nC.\n\n---\n\nD.\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    const one = stats.sections[0];
    expect(one?.children.map((c) => c.title)).toEqual(['A.', 'B.', 'Sub']);
    expect(one?.children[2]?.children.map((c) => c.title)).toEqual(['C.', 'D.']);
    expect(one?.words).toBe(6);
  });

  test('splits asciidoc at its thematic breaks', async () => {
    const source = "= Doc\n\n== Ch\n\nOne.\n\n'''\n\nTwo.\n";
    const stats = computeDocumentStats(await renderAsciidoc(source), { splitAtBreaks: true });
    expect(stats.separators).toBe(1);
    expect(stats.chapters[0]?.children.map((c) => c.title)).toEqual(['One.', 'Two.']);
  });

  test('a single chapter split by separators lists its runs as the rows', async () => {
    const source = '# Chapter Nine\n\nA scene.\n\n---\n\nAnother.\n';
    const stats = computeDocumentStats(await render(source), { splitAtBreaks: true });
    expect(stats.chapters.map((c) => [c.title, c.words])).toEqual([
      ['A scene.', 2],
      ['Another.', 1],
    ]);
    // The title heading is all that is left before them.
    expect(stats.preamble.words).toBe(2);
  });

  test('numbers separators in the summary too, though they split nothing', async () => {
    const source = [
      '<!-- summary -->',
      '',
      'A blurb.',
      '',
      '---',
      '',
      'More blurb.',
      '',
      '<!-- /summary -->',
      '',
      '# One',
      '',
      'A.',
      '',
      '---',
      '',
      'B.',
      '',
    ].join('\n');
    const rendered = await render(source);
    expect(rendered.blocks.filter((b) => b.kind === 'thematicBreak' && b.docMeta)).toHaveLength(1);
    const stats = computeDocumentStats(rendered, { splitAtBreaks: true });
    expect(stats.separators).toBe(1);
    expect(stats.chapters.map((c) => [c.title, c.break?.separator])).toEqual([
      ['A.', null],
      ['B.', 2],
    ]);
  });
});
