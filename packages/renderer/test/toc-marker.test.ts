import { describe, expect, test } from 'bun:test';
import { render } from '../src/index.js';

// The remark plugin rewrites matching paragraphs to
// `<div class="marginalia-toc-marker">`. The viewer's CSS hides it,
// but the HTML still carries the class so the DOCX exporter can
// recognise it. These tests go through the full render pipeline so
// sanitize-schema / rehype-raw interactions are covered too.

describe('remarkTocMarker', () => {
  test('converts a standalone [TOC] paragraph into a marker div', async () => {
    const { html } = await render('# Doc\n\n[TOC]\n\n## A\n\n## B\n');
    expect(html).toContain('class="marginalia-toc-marker"');
    // Literal "[TOC]" text must not survive into the rendered body.
    expect(html).not.toContain('[TOC]');
  });

  test('converts a standalone [[_TOC_]] paragraph into a marker div', async () => {
    const { html } = await render('# Doc\n\n[[_TOC_]]\n\n## A\n\n## B\n');
    expect(html).toContain('class="marginalia-toc-marker"');
    expect(html).not.toContain('[[_TOC_]]');
  });

  test('leaves [TOC] inside a code block as literal text', async () => {
    const md = ['```', '[TOC]', '```', ''].join('\n');
    const { html } = await render(md);
    // Shiki wraps tokens; the literal "[TOC]" still appears as text.
    expect(html).not.toContain('class="marginalia-toc-marker"');
    // The code block escapes the brackets.
    expect(html).toMatch(/\[TOC\]/);
  });

  test('leaves "inline [TOC] reference" inside a paragraph alone', async () => {
    // A marker must be the ENTIRE paragraph. If it's embedded in
    // surrounding prose, remark treats it as a link reference
    // fallback / text and we should not rewrite it.
    const md = 'See the table of contents: [TOC] shows sections.\n';
    const { html } = await render(md);
    expect(html).not.toContain('class="marginalia-toc-marker"');
  });

  test('tolerates surrounding whitespace on the marker line', async () => {
    const { html } = await render('   [TOC]   \n\n## A\n\n## B\n');
    expect(html).toContain('class="marginalia-toc-marker"');
  });

  test('multiple markers are all converted', async () => {
    const md = [
      '[TOC]',
      '',
      '## A',
      '',
      '[[_TOC_]]',
      '',
      '## B',
    ].join('\n');
    const { html } = await render(md);
    const matches = html.match(/class="marginalia-toc-marker"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('[[__TOC__]] (double underscores / strong emphasis) is NOT a marker', async () => {
    // The paragraph parses as `text("[[") + strong("TOC") + text("]]")`.
    // `mdast-util-to-string` strips both emphasis and strong, so the
    // stringified form matches `[[_TOC_]]`'s stringified form. The
    // plugin must distinguish them via the mdast wrapper type —
    // `emphasis` is a marker, `strong` is literal content — so an
    // author can write `[[__TOC__]]` in documentation without it
    // being swallowed.
    const md = '[[__TOC__]]\n';
    const { html } = await render(md);
    expect(html).not.toContain('class="marginalia-toc-marker"');
    // The content renders as literal brackets wrapping <strong>TOC</strong>.
    expect(html).toContain('<strong>TOC</strong>');
  });

  test('[[TOC]] with no underscores at all is NOT a marker', async () => {
    // Someone writing exactly `[[TOC]]` in prose gets literal text,
    // not a TOC. The canonical GitLab form is `[[_TOC_]]`; we only
    // accept that and `[TOC]`.
    const { html } = await render('[[TOC]]\n');
    expect(html).not.toContain('class="marginalia-toc-marker"');
    expect(html).toContain('[[TOC]]');
  });
});
