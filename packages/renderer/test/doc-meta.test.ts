import { describe, expect, test } from 'bun:test';
import { docMetaPlainText, extractDocMeta } from '../src/doc-meta-extract.js';
import { locateAllBlocks } from '../src/locate-block.js';
import { render } from '../src/render.js';
import { renderAsciidoc } from '../src/render-asciidoc.js';
import { computeDocumentStats } from '../src/stats.js';

const SOURCE = `# The Book

<!-- summary -->
Frankfurt, October 2015. Felix rides home.
<!-- /summary -->

<!-- about -->
Set in **autumn**.

- real streets
- real weather
<!-- /about -->

## Chapter One

It begins.
`;

describe('summary and about regions in Markdown', () => {
  test('wrap their blocks in a tagged section and drop the markers', async () => {
    const out = await render(SOURCE);
    expect(out.html).toContain('<section class="doc-meta" data-doc-meta="summary"><p data-block=');
    expect(out.html).toContain('<section class="doc-meta" data-doc-meta="about">');
    expect(out.html).not.toContain('summary -->');
    const summary = out.blocks.filter((b) => b.docMeta === 'summary');
    expect(summary.map((b) => b.kind)).toEqual(['html', 'paragraph', 'html']);
    const about = out.blocks.filter((b) => b.docMeta === 'about' && b.anchorable);
    expect(about.map((b) => b.kind)).toEqual(['paragraph', 'list', 'listItem', 'listItem']);
    expect(out.blocks.find((b) => b.text === 'It begins.')?.docMeta).toBeUndefined();
  });

  test('keep their blocks anchorable and locatable in the source', async () => {
    const out = await render(SOURCE);
    const para = out.blocks.find((b) => b.docMeta === 'summary' && b.kind === 'paragraph');
    expect(para?.anchorable).toBe(true);
    const range = para ? locateAllBlocks(SOURCE).get(para.id) : undefined;
    expect(range && SOURCE.slice(range.start, range.end)).toBe(
      'Frankfurt, October 2015. Felix rides home.',
    );
  });

  test('need a closing marker', async () => {
    const out = await render('<!-- summary -->\nOpen ended.\n');
    expect(out.html).not.toContain('doc-meta');
    expect(out.blocks.some((b) => b.docMeta)).toBe(false);
  });

  test('are left out of the statistics', async () => {
    const stats = computeDocumentStats(await render(SOURCE));
    // "The Book" + "Chapter One" + "It begins."
    expect(stats.total.words).toBe(6);
  });
});

describe('summary and about regions in AsciiDoc', () => {
  const ADOC = '= Book\n\n[.summary]\n--\nA blurb.\n\nSecond line.\n--\n\n== One\n\nText.\n';

  test('tag the open block and its block', async () => {
    const out = await renderAsciidoc(ADOC);
    expect(out.html).toMatch(
      /<div class="openblock summary doc-meta"[^>]* data-doc-meta="summary"/,
    );
    const tagged = out.blocks.filter((b) => b.docMeta === 'summary');
    expect(tagged.map((b) => b.kind)).toEqual(['open']);
    expect(tagged[0]?.anchorable).toBe(true);
  });

  test('are left out of the statistics', async () => {
    const stats = computeDocumentStats(await renderAsciidoc(ADOC));
    // "One" + "Text." — the document title is no block.
    expect(stats.total.words).toBe(2);
  });
});

describe('extractDocMeta', () => {
  test('cuts Markdown regions out and returns their text', () => {
    const meta = extractDocMeta(SOURCE, 'markdown');
    expect(meta.summary).toBe('Frankfurt, October 2015. Felix rides home.');
    expect(meta.about).toBe('Set in **autumn**.\n\n- real streets\n- real weather');
    expect(meta.source).toBe('# The Book\n\n\n\n## Chapter One\n\nIt begins.\n');
  });

  test('leaves a source without regions as it is', () => {
    const source = '# Plain\n\n<!-- a comment -->\n';
    expect(extractDocMeta(source, 'markdown')).toEqual({ source, summary: null, about: null });
  });

  test('gives a Markdown region as plain text', () => {
    expect(docMetaPlainText('Set in **autumn**.\n\nIn *Frankfurt*.', 'markdown')).toBe(
      'Set in autumn.\n\nIn Frankfurt.',
    );
  });

  test('finds an AsciiDoc role wherever the renderer does', async () => {
    const headers = [
      '[#blurb.summary.lead]',
      '[open.summary%collapsible]',
      '[role="lead summary"]',
      '.The blurb\n[.summary]',
      '[.summary]\n.The blurb',
    ];
    for (const header of headers) {
      const source = `= Book\n\n${header}\n--\nA blurb.\n--\n\n== One\n\nText.\n`;
      const rendered = await renderAsciidoc(source);
      expect(rendered.blocks.some((b) => b.docMeta === 'summary')).toBe(true);
      const meta = extractDocMeta(source, 'asciidoc');
      expect({ header, summary: meta.summary, source: meta.source }).toEqual({
        header,
        summary: 'A blurb.',
        source: '= Book\n\n\n== One\n\nText.\n',
      });
    }
  });

  test('leaves other AsciiDoc open blocks alone', () => {
    const source = '[.note]\n--\nKeep.\n--\n\n[.about]\n--\nNotes.\n--\n';
    const meta = extractDocMeta(source, 'asciidoc');
    expect(meta.about).toBe('Notes.');
    expect(meta.source).toBe('[.note]\n--\nKeep.\n--\n\n');
  });

  test('reads AsciiDoc open blocks with the role', () => {
    const source = '= Book\n\n[.summary]\n--\nA blurb.\n--\n\n== One\n\nText.\n';
    const meta = extractDocMeta(source, 'asciidoc');
    expect(meta.summary).toBe('A blurb.');
    expect(meta.about).toBeNull();
    expect(meta.source).toBe('= Book\n\n\n== One\n\nText.\n');
  });
});
