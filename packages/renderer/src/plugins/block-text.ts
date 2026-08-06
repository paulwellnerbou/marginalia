import type { Element, Root, RootContent } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { normalizeBlockText } from '../block-ids-shared.js';
import { INJECTED_CHROME_CLASSES } from '../injected-chrome.js';
import type { BlockInfo, BlockMap } from '../types.js';

/**
 * Re-read every block's `text` from the rendered tree, so the block map
 * describes the document the browser will actually show.
 *
 * The ids and the text are built from different trees on purpose. An id has
 * to be derivable from the source alone — `locateAllBlocks` recomputes them
 * with nothing but a markdown parser, which is what lets an edit proposal
 * map a block back to its source range. `text`, on the other hand, is what
 * comment anchoring searches, and the thing it searches *for* is a quote the
 * browser produced from `Range.toString()`. Derive that from mdast and the
 * two can never quite line up:
 *
 *   - mdast-util-to-string concatenates children with no separator, so a
 *     blockquote holding a heading and a paragraph reads "HeadingBody",
 *     while the DOM has whitespace between the two elements. Every child
 *     boundary was one character of drift.
 *   - it returns an image's `alt`, which the DOM does not expose as text at
 *     all — a paragraph that is just a picture claimed to hold its caption.
 *   - it never sees what rendering adds: footnote reference markers, or an
 *     AsciiDoc admonition's "Note" label.
 *
 * None of that is emulable rule-by-rule — the whitespace one isn't even
 * consistent, since HTML parsing ejects the newlines mdast-util-to-hast puts
 * inside a `<table>` but keeps the ones inside a `<blockquote>`. Reading the
 * finished tree sidesteps the whole question.
 *
 * Runs last, immediately before stringify, so the text comes from the same
 * markup the client receives.
 */

export interface RehypeBlockTextOptions {
  /**
   * The map to update. Defaults to `file.data.blocks`, which is where the
   * markdown pipeline's `remarkBlockIds` leaves it; the asciidoc pipeline
   * builds its map before the rehype pass runs and passes it in.
   */
  blocks?: BlockMap;
}

export const rehypeBlockText: Plugin<[RehypeBlockTextOptions?], Root> = (options = {}) => {
  return (tree, file) => {
    const blocks = options.blocks ?? (file.data as { blocks?: BlockMap }).blocks;
    if (!blocks || blocks.length === 0) return;

    // Duplicate-content blocks share an id and therefore share their text;
    // updating every entry keeps them consistent rather than leaving all but
    // one on the mdast reading.
    const byId = new Map<string, BlockInfo[]>();
    for (const block of blocks) {
      const bucket = byId.get(block.id);
      if (bucket) bucket.push(block);
      else byId.set(block.id, [block]);
    }

    const claimed = new Set<string>();
    visit(tree, 'element', (node: Element) => {
      const id = blockIdOf(node);
      if (id === null || claimed.has(id)) return;
      const targets = byId.get(id);
      if (!targets) return;
      // First element in document order wins, matching how the client
      // resolves an id (`querySelector`) when a document repeats a block.
      claimed.add(id);
      const text = normalizeBlockText(elementText(node));
      for (const target of targets) target.text = text;
    });
  };
};

/**
 * Property names are dashed while the tree still comes straight from
 * `hProperties`, and camel-cased once anything has round-tripped it through
 * an HTML parser (`rehype-raw` on the markdown side, `rehype-parse` on the
 * asciidoc one). Accept both so the pass isn't silently a no-op if it ever
 * moves earlier in a pipeline.
 */
function blockIdOf(node: Element): string | null {
  const props = node.properties;
  if (!props) return null;
  const raw =
    props['dataSubblock'] ?? props['data-subblock'] ?? props['dataBlock'] ?? props['data-block'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** `textContent`, minus the injected chrome. Mirrors the client's `blockTextOf`. */
function elementText(node: RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' && isInjectedChrome(node)) return '';
  if (!('children' in node)) return '';
  let out = '';
  for (const child of node.children) out += elementText(child);
  return out;
}

function isInjectedChrome(node: Element): boolean {
  const className = node.properties?.['className'];
  const classes = Array.isArray(className)
    ? className
    : typeof className === 'string'
      ? className.split(/\s+/)
      : [];
  return classes.some((c) => INJECTED_CHROME_CLASSES.includes(String(c)));
}
