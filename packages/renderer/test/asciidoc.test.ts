import { describe, expect, test } from 'bun:test';
import {
  renderAsciidoc,
  renderDocument,
  locateAllBlocksAsciidoc,
  isDocumentFormat,
} from '../src/index.js';

describe('renderAsciidoc', () => {
  test('renders a basic document with sections, paragraphs, and a listing', async () => {
    const src = `= My Doc
:author: Paul
:revdate: 2026-04-19

This is a paragraph.

== Section One

A para in section one.

[source,javascript]
----
console.log('hi');
----
`;
    const r = await renderAsciidoc(src);

    expect(r.html).toContain('<h2');
    expect(r.html).toContain('Section One');
    expect(r.anchors).toHaveLength(1);
    expect(r.anchors[0]).toMatchObject({ level: 2, text: 'Section One', id: '_section_one' });
    expect(r.toc).toHaveLength(1);
    expect(r.frontmatter.title).toBe('My Doc');
    expect(r.frontmatter.author).toBe('Paul');
    expect(r.frontmatter.revdate).toBe('2026-04-19');
  });

  test('attaches data-block to every top-level block', async () => {
    const src = `= Title

Para one.

== Heading

Para two.
`;
    const r = await renderAsciidoc(src);
    // heading + two paragraphs
    expect(r.blocks.length).toBe(3);
    for (const block of r.blocks) expect(block.id).toMatch(/^[0-9a-f]{16}$/);
    for (const block of r.blocks) expect(r.html).toContain(`data-block="${block.id}"`);
  });

  test('heading block id lives on the <h2>, not on the section wrapper', async () => {
    const src = `= T

== Section

Text.
`;
    const r = await renderAsciidoc(src);
    const headingBlock = r.blocks.find((b) => b.kind === 'heading' && b.text === 'Section');
    expect(headingBlock).toBeTruthy();
    // Look for <h2 ... data-block="..."> with the same id. The section
    // wrapper should not carry data-block.
    const h2Pattern = new RegExp(`<h2[^>]*data-block="${headingBlock!.id}"`);
    expect(r.html).toMatch(h2Pattern);
    expect(r.html).not.toMatch(/<div class="sect1"[^>]*data-block=/);
  });

  test('builds a nested TOC across h2/h3 levels', async () => {
    const src = `= T

== A

=== A1

== B
`;
    const r = await renderAsciidoc(src);
    expect(r.toc).toHaveLength(2);
    expect(r.toc[0]!.text).toBe('A');
    expect(r.toc[0]!.children).toHaveLength(1);
    expect(r.toc[0]!.children[0]!.text).toBe('A1');
    expect(r.toc[1]!.text).toBe('B');
    expect(r.toc[1]!.children).toHaveLength(0);
  });

  test('block IDs are stable when a later block changes', async () => {
    const a = await renderAsciidoc('Para one.\n\nPara two.\n');
    const b = await renderAsciidoc('Para one.\n\nPara two changed.\n');
    expect(a.blocks[0]!.id).toBe(b.blocks[0]!.id);
    expect(a.blocks[1]!.id).not.toBe(b.blocks[1]!.id);
  });

  test('collects image and link assets', async () => {
    const src = `image::cat.jpg[a cat]

See https://example.com[here] for details.
`;
    const r = await renderAsciidoc(src);
    const srcs = r.assets.map((a) => a.src);
    expect(srcs).toContain('cat.jpg');
    expect(srcs).toContain('https://example.com');
    const img = r.assets.find((a) => a.kind === 'image');
    expect(img?.alt).toBe('a cat');
  });

  test('lowers [mermaid] listing blocks to the shared mermaid container shape', async () => {
    const src = `[mermaid]
----
graph TD
A --> B
----
`;
    const r = await renderAsciidoc(src);
    expect(r.mermaid).toHaveLength(1);
    expect(r.mermaid[0]!.source).toBe('graph TD\nA --> B');
    expect(r.html).toContain('<div class="mermaid"');
    expect(r.html).toContain('data-mermaid-index="0"');
    expect(r.html).toContain('data-mermaid-mode="client"');
    // The mermaid div still carries the comment-anchoring data-block —
    // so this block is addressable by comments and proposals just like
    // the markdown `remarkMermaid` path.
    const mermaidBlock = r.blocks.find((b) => b.text.includes('graph TD'));
    expect(mermaidBlock).toBeTruthy();
    expect(r.html).toMatch(new RegExp(`<div class="mermaid"[^>]*data-block="${mermaidBlock!.id}"`));
  });

  test('also lowers [source,mermaid] to the mermaid container shape', async () => {
    const src = `[source,mermaid]
----
graph LR
X --> Y
----
`;
    const r = await renderAsciidoc(src);
    expect(r.mermaid).toHaveLength(1);
    expect(r.mermaid[0]!.source).toContain('graph LR');
    expect(r.html).toContain('<div class="mermaid"');
  });

  test('Shiki highlights [source,lang] code blocks', async () => {
    const src = `[source,javascript]
----
const x = 1;
----
`;
    const r = await renderAsciidoc(src);
    expect(r.html).toContain('shiki');
    expect(r.html).toContain('language-javascript');
    // Shiki injects per-token inline styles — proof it ran.
    expect(r.html).toContain('--shiki-light');
  });

  test('sanitizes script tags that slip through as pass-through HTML', async () => {
    const src = `++++
<script>alert(1)</script>
++++
`;
    const r = await renderAsciidoc(src);
    expect(r.html).not.toContain('<script');
  });

  test('injects a permalink anchor into every heading with an id', async () => {
    const src = `= Doc\n\n== Section One\n\n=== Nested\n\nText.\n`;
    const r = await renderAsciidoc(src);
    // Themes style these with the `heading-anchor` class so they appear on hover.
    expect(r.html).toContain('class="heading-anchor"');
    expect(r.html).toMatch(/href="#_section_one"/);
    expect(r.html).toMatch(/href="#_nested"/);
  });

  test('surfaces `= Title` as a visible <h1> in the rendered body', async () => {
    const r = await renderAsciidoc(`= My Document\n\nBody.\n`);
    expect(r.html).toMatch(/<h1[^>]*>My Document<\/h1>/);
  });

  test('attaches data-subblock to ulist/olist items so Propose edit targets them', async () => {
    const r = await renderAsciidoc(`* first item\n* second item\n** nested\n`);
    const matches = [...r.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]);
    expect(matches).toHaveLength(3);
    expect(new Set(matches).size).toBe(3);
  });

  test('`:experimental:` is on by default — kbd/btn/menu macros resolve', async () => {
    const r = await renderAsciidoc(
      `Press kbd:[Ctrl+S]. Click btn:[Submit]. Use menu:File[Open].`,
    );
    expect(r.html).toContain('<kbd>Ctrl</kbd>');
    expect(r.html).toContain('<kbd>S</kbd>');
    expect(r.html).toContain('class="button"');
    expect(r.html).toContain('class="menuseq"');
  });

  test('Shiki handles mainstream non-JS languages (java, kotlin, python, ruby)', async () => {
    for (const lang of ['java', 'kotlin', 'python', 'ruby']) {
      const r = await renderAsciidoc(`[source,${lang}]\n----\nfoo()\n----`);
      expect(r.html).toMatch(new RegExp(`<pre[^>]*\\bshiki\\b[^>]*\\blanguage-${lang}\\b`));
      expect(r.warnings.filter((w) => w.kind === 'unknown-language')).toHaveLength(0);
    }
  });

  test('Shiki highlights a `[source,lang]` block even inside an .exampleblock', async () => {
    const r = await renderAsciidoc(`[example]
====
[source,javascript]
----
const x = 1;
----
====
`);
    // Both wrappers are present…
    expect(r.html).toContain('class="exampleblock"');
    // …and the inner pre still gets shiki applied.
    expect(r.html).toMatch(/<pre[^>]*\bshiki\b[^>]*\blanguage-javascript\b/);
    expect(r.html).toContain('--shiki-light');
  });

  test('renderDocument dispatches on format', async () => {
    const md = await renderDocument('# Title\n\nBody.\n', 'markdown');
    const adoc = await renderDocument('= Title\n\nBody.\n', 'asciidoc');
    expect(md.html).toContain('<h1');
    expect(adoc.frontmatter.title).toBe('Title');
  });

  test('isDocumentFormat guard', () => {
    expect(isDocumentFormat('markdown')).toBe(true);
    expect(isDocumentFormat('asciidoc')).toBe(true);
    expect(isDocumentFormat('txt')).toBe(false);
    expect(isDocumentFormat(null)).toBe(false);
  });
});

describe('locateAllBlocksAsciidoc', () => {
  test('round-trips every rendered block id to a source range', async () => {
    const src = `= Doc

First para.

== Section

Second para.
`;
    const r = await renderAsciidoc(src);
    const locs = locateAllBlocksAsciidoc(src);

    for (const block of r.blocks) {
      const range = locs.get(block.id);
      expect(range).toBeDefined();
      // Source window should contain the block's text (for paragraphs;
      // heading ranges include the `==` prefix, so check inclusion).
      if (block.kind !== 'heading') {
        const window = src.slice(range!.start, range!.end);
        const snippet = block.text.split(' ')[0]!;
        expect(window).toContain(snippet);
      }
    }
  });

  test('non-overlapping ranges for neighboring paragraphs', () => {
    const src = `Alpha.

Bravo.
`;
    const locs = locateAllBlocksAsciidoc(src);
    const ranges = Array.from(locs.values()).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end - 1);
    }
  });

  test('delimited compound blocks ([NOTE] / [quote] / [example]) span open→close', async () => {
    const src = `[NOTE]
====
First line.

Second line.
====

[quote]
____
Quoted.
____
`;
    const r = await renderAsciidoc(src);
    const locs = locateAllBlocksAsciidoc(src);

    const note = r.blocks.find((b) => b.kind === 'admonition');
    const quote = r.blocks.find((b) => b.kind === 'quote');
    expect(note).toBeTruthy();
    expect(quote).toBeTruthy();

    const noteRange = locs.get(note!.id);
    const quoteRange = locs.get(quote!.id);
    expect(noteRange).toBeTruthy();
    expect(quoteRange).toBeTruthy();

    // The NOTE range must include both the opening and the closing `====`,
    // plus the body — otherwise the Propose-edit composer would open
    // with just `====` in the textarea.
    const noteWindow = src.slice(noteRange!.start, noteRange!.end);
    expect(noteWindow.startsWith('====')).toBe(true);
    expect(noteWindow).toContain('First line.');
    expect(noteWindow).toContain('Second line.');
    expect(noteWindow.trimEnd().endsWith('====')).toBe(true);

    const quoteWindow = src.slice(quoteRange!.start, quoteRange!.end);
    expect(quoteWindow.startsWith('____')).toBe(true);
    expect(quoteWindow).toContain('Quoted.');
    expect(quoteWindow.trimEnd().endsWith('____')).toBe(true);
  });

  test('open blocks (`--` delimiter) span opener to closer, not just one line', async () => {
    const src = `[open]\n--\nFirst.\n\nSecond.\n--\n`;
    const r = await renderAsciidoc(src);
    const locs = locateAllBlocksAsciidoc(src);
    const open = r.blocks.find((b) => b.kind === 'open');
    expect(open).toBeTruthy();
    const range = locs.get(open!.id);
    expect(range).toBeTruthy();
    const window = src.slice(range!.start, range!.end);
    expect(window.startsWith('--')).toBe(true);
    expect(window).toContain('First.');
    expect(window).toContain('Second.');
    expect(window.trimEnd().endsWith('--')).toBe(true);
  });

  test('list item sub-block ids round-trip back to their source line', async () => {
    const src = `* alpha\n* bravo\n`;
    const r = await renderAsciidoc(src);
    const locs = locateAllBlocksAsciidoc(src);

    const subIds = [...r.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]);
    expect(subIds).toHaveLength(2);
    for (const id of subIds) {
      const range = locs.get(id!);
      expect(range).toBeDefined();
      const window = src.slice(range!.start, range!.end);
      expect(window.startsWith('* ')).toBe(true);
    }
  });
});
