import { describe, expect, test } from 'bun:test';
import type { Element, Root as HastRoot, RootContent } from 'hast';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import { hashBlock, normalizeBlockText } from '../src/block-ids-shared.js';
import { render, renderAsciidoc } from '../src/index.js';
import { INJECTED_CHROME_CLASSES } from '../src/injected-chrome.js';
import type { BlockMap } from '../src/types.js';

/**
 * The block map's `text` has to be the string the browser will read out of
 * the rendered document, because that is where the quotes comment anchoring
 * searches for come from. These tests re-parse the emitted HTML the same way
 * a browser does (`innerHTML`) and stand in for the client's `blockTextOf`,
 * so any future divergence between the two readings fails here rather than
 * silently shifting every anchor offset inside a container block.
 */

const htmlParser = unified().use(rehypeParse, { fragment: true });

function classesOf(node: Element): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  return typeof className === 'string' ? className.split(/\s+/) : [];
}

/** The client's `blockTextOf`, over a parsed tree instead of a live DOM. */
function blockTextOf(node: RootContent | HastRoot): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' && classesOf(node).some((c) => INJECTED_CHROME_CLASSES.includes(c))) {
    return '';
  }
  if (!('children' in node)) return '';
  let out = '';
  for (const child of node.children) out += blockTextOf(child);
  return out;
}

/** Every `data-block` / `data-subblock` element's text, by id, first wins. */
function domTextById(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: RootContent | HastRoot): void => {
    if (!('children' in node)) return;
    for (const child of node.children) {
      if (child.type === 'element') {
        // Parsing an HTML string always yields the camel-cased spelling; the
        // hyphenated one only exists on a tree still carrying raw
        // `hProperties`, which never reaches here. `blockIdOf` in the plugin
        // accepts both because it can be moved earlier in a pipeline — this
        // cannot, so a second lookup here would be a branch that never runs.
        // The elementless assertion below is what catches a lookup that has
        // stopped finding anything.
        const props = child.properties ?? {};
        const id = props['dataSubblock'] ?? props['dataBlock'];
        if (typeof id === 'string' && !out.has(id)) {
          out.set(id, normalizeBlockText(blockTextOf(child)));
        }
      }
      walk(child as RootContent);
    }
  };
  walk(htmlParser.parse(html) as HastRoot);
  return out;
}

/**
 * Block kinds that legitimately reach the map with no element to compare
 * against: Shiki replaces the `<pre>` and drops the attribute, `rehype-raw`
 * loses it re-parsing raw HTML, and footnote definitions are moved into a
 * generated `<section class="footnotes">`.
 */
const ELEMENTLESS_KINDS = new Set(['code', 'html', 'footnoteDefinition']);

function expectMapMatchesDom(html: string, blocks: BlockMap): number {
  const dom = domTextById(html);
  let checked = 0;
  for (const block of blocks) {
    const rendered = dom.get(block.id);
    if (rendered === undefined) {
      // Anything else missing means the id lookup stopped working, not that
      // the block has no element. Skipping silently would let this whole
      // file keep passing while checking almost nothing.
      expect({ kind: block.kind, foundInDom: false }).toEqual({
        kind: block.kind,
        foundInDom: !ELEMENTLESS_KINDS.has(block.kind),
      });
      continue;
    }
    checked++;
    expect({ id: block.id, kind: block.kind, text: block.text }).toEqual({
      id: block.id,
      kind: block.kind,
      text: rendered,
    });
  }
  return checked;
}

const MARKDOWN_SHAPES: Record<string, string> = {
  'blockquote wrapping a heading and a paragraph':
    '# Top\n\n> ## Quoted heading\n>\n> Body inside the quote.\n\nPlain paragraph.\n',
  'blockquote of two paragraphs': '> First para.\n>\n> Second para.\n',
  'nested blockquote': '> Outer text.\n>\n> > Inner quote.\n',
  'blockquote holding a list': '> Lead in:\n>\n> - a\n> - b\n',
  'tight list': 'Intro.\n\n- One\n- Two\n- Three\n',
  'loose list': '- One\n\n- Two\n\n- Three\n',
  'list item of two paragraphs': '- First para\n\n  Second para\n- Other item\n',
  'nested list': '- Outer\n  - Inner a\n  - Inner b\n',
  'task list': '- [ ] todo one\n- [x] done two\n',
  'heading inside a list item': '- Item\n\n  # Big\n',
  table: '| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n',
  'table cell with an escaped pipe': '| A | B |\n| - | - |\n| `x\\|y` | 2 |\n',
  'image in a paragraph': 'Here is ![a diagram of the flow](x.png) inline.\n',
  'image-only paragraph': '![Screenshot of the editor](y.png)\n',
  'image in a heading': '## Title ![icon](i.png)\n',
  'footnote reference': 'Text with a note[^1].\n\n[^1]: The note body.\n',
  'inline markup': 'A paragraph with **bold** and `code` and _em_ run together.\n',
  'thematic break': 'Before.\n\n---\n\nAfter.\n',
  'raw html block': '<div>\n  <p>Raw html para one.</p>\n</div>\n\nAfter.\n',
};

describe('block map text matches the rendered document', () => {
  for (const [name, source] of Object.entries(MARKDOWN_SHAPES)) {
    test(name, async () => {
      const result = await render(source);
      expect(expectMapMatchesDom(result.html, result.blocks)).toBeGreaterThan(0);
    });
  }

  test('asciidoc: inline markup, quote block, admonition, list', async () => {
    const source = [
      '= Doc',
      '',
      'Hello *world*, and `code` too.',
      '',
      '[quote]',
      '____',
      'First para.',
      '',
      'Second para.',
      '____',
      '',
      '[NOTE]',
      '====',
      'Lead.',
      '',
      '* a',
      '* b',
      '====',
      '',
    ].join('\n');
    const result = await renderAsciidoc(source);
    expect(expectMapMatchesDom(result.html, result.blocks)).toBeGreaterThan(0);
  });
});

describe('block ids stay decoupled from the rendered text', () => {
  test('a container block keeps the id its source AST hashes to', async () => {
    const result = await render('> ## Quoted heading\n>\n> Body inside the quote.\n');
    const quote = result.blocks.find((b) => b.kind === 'blockquote');

    // Reading the text off the DOM must not leak into the id: every stored
    // comment anchor points at the source-AST hash, and re-hashing here
    // would orphan all of them on the next save.
    expect(quote?.id).toBe(hashBlock('blockquote', 'Quoted headingBody inside the quote.'));
    expect(quote?.text).toBe('Quoted heading Body inside the quote.');
  });

  test('a list keeps the id its source AST hashes to', async () => {
    const result = await render('- One\n- Two\n- Three\n');
    const list = result.blocks.find((b) => b.kind === 'list');

    expect(list?.id).toBe(hashBlock('list', 'OneTwoThree'));
    expect(list?.text).toBe('One Two Three');
  });

  test('duplicate blocks sharing an id both get the rendered text', async () => {
    const result = await render('> a\n>\n> b\n\nSpacer.\n\n> a\n>\n> b\n');
    const quotes = result.blocks.filter((b) => b.kind === 'blockquote');

    expect(quotes).toHaveLength(2);
    expect(quotes[0]!.id).toBe(quotes[1]!.id);
    expect(quotes.map((q) => q.text)).toEqual(['a b', 'a b']);
  });
});
