import { describe, expect, test } from 'bun:test';
import { locateBlocks } from '@marginalia/renderer/locate-block';
import { locateBlocksAsciidoc } from '@marginalia/renderer/locate-block-asciidoc';
import { renderDocument } from '@marginalia/renderer/render';
import {
  chapterCopyParam,
  chapterEditQuery,
  resolveChapterScopeFromBlocks,
  resolveDocMetaScope,
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

/**
 * The blocks the viewer's DOM lists, read off the rendered HTML: what the
 * editor pairs, in order, with the locator's occurrences.
 */
function renderedBlocks(html: string) {
  return [...html.matchAll(/<(\w+)[^>]*\sdata-block="([^"]+)"/g)].map((m) => {
    const heading = /^h([1-6])$/i.exec(m[1]!);
    return { id: m[2]!, headingLevel: heading ? Number(heading[1]) : null };
  });
}

describe.each([
  {
    format: 'markdown' as const,
    locate: locateBlocks,
    book: '# Book\n\n## Chapter 4\n\nNew prose.\n\nThe end.\n\n## Chapter 4\n\nOld prose.\n\nThe end.\n',
    second: '## Chapter 4\n\nOld prose.\n\nThe end.',
  },
  {
    format: 'asciidoc' as const,
    locate: locateBlocksAsciidoc,
    book: '= Book\n\n== Chapter 4\n\nNew prose.\n\nThe end.\n\n== Chapter 4\n\nOld prose.\n\nThe end.\n',
    second: '== Chapter 4\n\nOld prose.\n\nThe end.\n',
  },
])('a rendered $format book with two same-titled chapters', ({ format, locate, book, second }) => {
  test('the second copy of the heading opens the second chapter', async () => {
    const { html } = await renderDocument(book, format);
    const blocks = renderedBlocks(html);
    const { occurrences } = locate(book);
    // The pairing only holds while both walks list the same blocks in
    // the same order.
    expect(blocks.map((b) => b.id)).toEqual(
      [...occurrences.values()]
        .flat()
        .sort((a, b) => a.start - b.start)
        .map((o) => o.id),
    );
    const heading = blocks.find((b) => b.headingLevel === 2)!.id;
    const scope = resolveChapterScopeFromBlocks(book, occurrences, blocks, heading, 1);
    expect(scope?.source).toBe(second);
    expect(scope?.section.section_index).toBe(3);
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

describe('resolveDocMetaScope', () => {
  async function scopeOf(src: string, kind: 'summary' | 'about', format: 'markdown' | 'asciidoc') {
    const rendered = await renderDocument(src, format);
    const { occurrences } = format === 'asciidoc' ? locateBlocksAsciidoc(src) : locateBlocks(src);
    return resolveDocMetaScope(src, occurrences, rendered.blocks, kind);
  }

  const md =
    '# Book\n\n<!-- summary -->\nFirst line.\n\nSecond line.\n<!-- /summary -->\n\n' +
    '<!-- about -->\nNotes.\n<!-- /about -->\n\n## One\n\nText.\n';

  test('spans the region between its markers, markers left out', async () => {
    const scope = await scopeOf(md, 'summary', 'markdown');
    expect(scope?.source).toBe('First line.\n\nSecond line.');
    expect(scope?.title).toBe('Summary');
    expect(scope?.docMeta).toBe('summary');
    expect(scope && md.slice(scope.start, scope.end)).toBe(scope?.source ?? null);
    expect(scope?.blockIds.length).toBe(2);
    expect((await scopeOf(md, 'about', 'markdown'))?.source).toBe('Notes.');
  });

  test('is null without a region, or with only its markers', async () => {
    expect(await scopeOf('# Book\n\nText.\n', 'summary', 'markdown')).toBeNull();
    expect(
      await scopeOf('<!-- summary -->\n<!-- /summary -->\n\nText.\n', 'summary', 'markdown'),
    ).toBeNull();
  });

  test('takes only the first region of a kind', async () => {
    const twice =
      '<!-- about -->\nA.\n<!-- /about -->\n\nMiddle.\n\n<!-- about -->\nB.\n<!-- /about -->\n';
    expect((await scopeOf(twice, 'about', 'markdown'))?.source).toBe('A.');
  });

  test('finds the AsciiDoc open block', async () => {
    const adoc = '= Book\n\n[.summary]\n--\nA blurb.\n--\n\n== One\n\nText.\n';
    const scope = await scopeOf(adoc, 'summary', 'asciidoc');
    expect(scope?.title).toBe('Summary');
    expect(scope?.source).toBe('A blurb.');
    expect(scope?.proposalWrap).toEqual({ before: '--\n', after: '\n--\n' });
    expect(scope && adoc.slice(scope.start, scope.end)).toBe('A blurb.');
    expect(
      await scopeOf('= Book\n\n[.summary]\n--\n--\n\nText.\n', 'summary', 'asciidoc'),
    ).toBeNull();
  });
});
