import { describe, expect, test } from 'bun:test';
import { render, renderDocument } from '../src/index.js';
import type { BlockMap } from '../src/types.js';

/**
 * `BlockInfo.anchorable` claims the block's id was written to an element
 * in the rendered HTML. Comment anchoring trusts that claim — `reanchor`
 * only ranks anchorable blocks, because an anchor stored against a block
 * with no element resolves to nothing in the browser and the comment's
 * highlight silently never appears.
 *
 * So the claim has to be checked against the HTML itself, not against a
 * list of block kinds someone maintained by hand: the kinds that lose
 * their attribute are the ones a plugin quietly rebuilds, and that set
 * moves whenever the pipeline does.
 */

function idsInHtml(html: string): Set<string> {
  const out = new Set<string>();
  const re = /\bdata-(?:sub)?block="([^"]*)"/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) out.add(m[1]!);
  return out;
}

function expectAnchorableMatchesHtml(blocks: BlockMap, html: string): void {
  const present = idsInHtml(html);
  for (const block of blocks) {
    expect({ kind: block.kind, text: block.text, anchorable: block.anchorable }).toEqual({
      kind: block.kind,
      text: block.text,
      anchorable: present.has(block.id),
    });
  }
}

const KITCHEN_SINK = `---
title: Frontmatter Doc
---

# Heading

Intro paragraph.

\`\`\`js
const highlighted = 1;
\`\`\`

\`\`\`
unhighlighted code
\`\`\`

\`\`\`mermaid
graph TD;
A-->B;
\`\`\`

<div class="raw">
  <p>Raw HTML block.</p>
</div>

- list item A
- list item B

| h1 | h2 |
|----|----|
| a  | b  |

> Quoted line.

---

Referenced footnote[^used].

[^used]: Used footnote body.

[^unused]: Unused footnote body.
`;

describe('anchorable', () => {
  test('every block reports truthfully whether its id reached the HTML', async () => {
    const result = await render(KITCHEN_SINK);
    expectAnchorableMatchesHtml(result.blocks, result.html);
  });

  test('holds for asciidoc too, including raw passthrough blocks', async () => {
    const result = await renderDocument(
      `= Doc

Intro para.

[source,js]
----
const a = 1;
----

++++
<div>raw passthrough</div>
++++
`,
      'asciidoc',
    );
    expectAnchorableMatchesHtml(result.blocks, result.html);
    const pass = result.blocks.find((b) => b.text.includes('raw passthrough'));
    expect(pass?.anchorable).toBe(false);
  });

  test('blocks the pipeline renders to no element are excluded', async () => {
    const result = await render(KITCHEN_SINK);
    const byText = (needle: string) => result.blocks.find((b) => b.text.includes(needle));

    // Raw HTML is re-parsed by rehype-raw, which keeps no tie back to the
    // mdast node — and the block's `text` is the markup itself, not the
    // rendered words, so there is nothing coherent to anchor to anyway.
    expect(byText('Raw HTML block.')?.anchorable).toBe(false);
    // Frontmatter renders to nothing at all.
    expect(byText('title: Frontmatter Doc')?.anchorable).toBe(false);
    // A mermaid fence becomes a generated <div> whose text is diagram
    // source until the client runtime replaces it with an SVG.
    expect(byText('graph TD;')?.anchorable).toBe(false);
    // Nothing references it, so no <li> is generated for it.
    expect(byText('Unused footnote body.')?.anchorable).toBe(false);
  });

  test('ordinary prose blocks stay anchorable', async () => {
    const result = await render(KITCHEN_SINK);
    for (const kind of ['heading', 'paragraph', 'list', 'listItem', 'table', 'tableCell']) {
      const block = result.blocks.find((b) => b.kind === kind);
      expect(block, `expected a ${kind} block`).toBeDefined();
      expect(block?.anchorable, `${kind} should be anchorable`).toBe(true);
    }
  });
});

describe('code blocks', () => {
  test('carry data-block on <pre>, highlighted or not', async () => {
    const highlighted = await render('```js\nconst a = 1;\n```\n');
    const plain = await render('```\nconst a = 1;\n```\n');

    for (const result of [highlighted, plain]) {
      const block = result.blocks.find((b) => b.kind === 'code');
      expect(block?.anchorable).toBe(true);
      // On the <pre>, not the <code> the mdast handler put it on — Shiki
      // rebuilds the subtree and carries over only the <pre>'s properties,
      // so an id left below it survives one of these two paths and not
      // the other.
      expect(result.html).toContain(`<pre data-block="${block?.id}"`);
    }
  });

  test('block text matches what the element reads, so offsets mean the same thing', async () => {
    const result = await render('```js\nconst a = 1;\n```\n');
    const block = result.blocks.find((b) => b.kind === 'code');
    const text = result.html
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/gu, ' ')
      .trim();
    expect(text).toBe(block?.text ?? '');
  });
});

describe('footnote definitions', () => {
  test('attach to their generated <li>', async () => {
    const result = await render('Note[^1].\n\n[^1]: Body here.\n');
    const block = result.blocks.find((b) => b.kind === 'footnoteDefinition');
    expect(block?.anchorable).toBe(true);
    expect(result.html).toContain(`<li id="user-content-fn-1" data-block="${block?.id}">`);
  });

  test('match by source position, not by list order', async () => {
    // mdast-util-to-hast orders the footnotes section by first reference,
    // so the <li> for [^b] is emitted before the one for [^a]. Pairing
    // them off positionally would swap the two ids.
    const result = await render('A[^b] then B[^a].\n\n[^a]: Alpha.\n\n[^b]: Beta.\n');
    const alpha = result.blocks.find((b) => b.text === 'Alpha.');
    const beta = result.blocks.find((b) => b.text === 'Beta.');
    expect(result.html).toContain(`<li id="user-content-fn-b" data-block="${beta?.id}">`);
    expect(result.html).toContain(`<li id="user-content-fn-a" data-block="${alpha?.id}">`);
  });

  test('the <li> reads as the block text once the injected backref is dropped', async () => {
    // What `blockTextOf` does client-side: the ↩ backreference is grafted
    // in by mdast-util-to-hast and has no counterpart in the block map.
    const result = await render('Note[^1].\n\n[^1]: Body here.\n');
    const block = result.blocks.find((b) => b.kind === 'footnoteDefinition');
    const li = result.html.match(/<li id="user-content-fn-1"[^>]*>([\s\S]*?)<\/li>/)?.[1] ?? '';
    const text = li
      .replace(/<a[^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/gu, ' ')
      .trim();
    expect(text).toBe(block?.text ?? '');
  });
});
