import type { Element, Root } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import type { BlockMap } from '../types.js';

/**
 * Keeping the block map's ids and the rendered elements in agreement.
 *
 * `remarkBlockIds` writes `data-block` onto mdast nodes, but an mdast node
 * is not an element, and several handlers downstream build their output
 * from scratch rather than decorating what they were given. Whatever they
 * drop, the client can no longer resolve: `resolveAnchorElement` looks the
 * id up with `querySelector`, so a block whose attribute went missing is a
 * comment that silently disappears.
 *
 * Two passes here recover the cases where a real element does exist, and a
 * third reports what actually survived so `BlockInfo.anchorable` describes
 * the page rather than the intent.
 */

/** Keyed by the source offset the mdast node started at. */
export type BlockOffsets = Map<number, string>;

/**
 * `data-block` reaches hast under two spellings depending on where in the
 * pipeline you look: plugins that set `hProperties` write the literal
 * attribute name, while anything re-parsed from HTML — everything
 * downstream of `rehype-raw` — comes back as the DOM property name
 * `dataBlock`. Reading both means these passes don't quietly stop working
 * if they move relative to that boundary.
 */
const BLOCK_ATTRS = ['data-block', 'dataBlock'] as const;
const SUBBLOCK_ATTRS = ['data-subblock', 'dataSubblock'] as const;

function readAttr(node: Element, names: readonly string[]): string | null {
  for (const name of names) {
    const value = node.properties?.[name];
    if (typeof value === 'string') return value;
  }
  return null;
}

interface BlockElementData {
  /** Written by `remarkBlockIds`, read by `rehypeFootnoteBlockIds`. */
  footnoteBlockOffsets?: BlockOffsets;
  /** Written by `rehypeCollectRenderedBlockIds`. */
  renderedBlockIds?: Set<string>;
}

/**
 * Give each footnote definition's generated `<li>` its block id.
 *
 * `mdast-util-to-hast` collects footnote definitions into a `<section
 * class="footnotes">` it synthesizes at the end of the document, building
 * each `<li>` itself and taking only the definition's *children* — so
 * `hProperties` on the definition never reach an element.
 *
 * It does call `state.patch`, which copies the definition's source
 * position onto the `<li>`, and that is what we match on. Matching by
 * position rather than by reconstructing the generated `id`
 * (`user-content-fn-<identifier>`) keeps us out of the business of
 * mirroring the clobber prefix and identifier normalization that produce
 * it. The list is ordered by first reference, not source order, and
 * definitions nobody references are left out entirely; keying on offsets
 * is indifferent to both.
 *
 * MUST run before `rehype-raw`, which re-parses the tree and recomputes
 * positions against its own intermediate HTML.
 */
export const rehypeFootnoteBlockIds: Plugin<[], Root> = () => {
  return (tree, file) => {
    const offsets = (file.data as BlockElementData).footnoteBlockOffsets;
    if (!offsets?.size) return;
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'li') return;
      const start = node.position?.start?.offset;
      if (start === undefined) return;
      const id = offsets.get(start);
      if (!id) return;
      node.properties ??= {};
      node.properties['data-block'] = id;
    });
  };
};

/**
 * Move a code block's `data-block` from its `<code>` up to the `<pre>`.
 *
 * `mdast-util-to-hast` applies a `code` node's `hProperties` to the
 * `<code>` and then wraps that in a `<pre>` it creates itself, so the id
 * lands one level too deep — and Shiki, which replaces the whole subtree
 * with re-parsed highlighter output, only carries over the `<pre>`'s own
 * properties. Hoisting first means Shiki's existing preservation does the
 * rest, and unhighlighted blocks (no language, unknown language,
 * plaintext) end up carrying the attribute on the same element as
 * highlighted ones instead of on whichever element happened to survive.
 *
 * This is also what the asciidoc pipeline already does — there the marker
 * role lands on asciidoctor's wrapper `<div>`, safely outside anything
 * Shiki rewrites, which is why code blocks are commentable in `.adoc`
 * documents and were not in `.md` ones.
 *
 * MUST run before `rehypeShikiHighlight`.
 */
export const rehypeHoistCodeBlockIds: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') return;
      for (const child of node.children) {
        if (child.type !== 'element' || child.tagName !== 'code') continue;
        const id = readAttr(child, BLOCK_ATTRS);
        if (id === null) continue;
        node.properties ??= {};
        if (readAttr(node, BLOCK_ATTRS) === null) node.properties.dataBlock = id;
        for (const name of BLOCK_ATTRS) delete child.properties?.[name];
      }
    });
  };
};

/**
 * Record every block id present in the finished tree.
 *
 * MUST run last — after Shiki, sanitization, and anything else that can
 * rewrite or strip an element — so the set reflects the HTML that is
 * actually emitted.
 */
export const rehypeCollectRenderedBlockIds: Plugin<[], Root> = () => {
  return (tree, file) => {
    const found = new Set<string>();
    visit(tree, 'element', (node: Element) => {
      const block = readAttr(node, BLOCK_ATTRS);
      if (block !== null) found.add(block);
      const sub = readAttr(node, SUBBLOCK_ATTRS);
      if (sub !== null) found.add(sub);
    });
    (file.data as BlockElementData).renderedBlockIds = found;
  };
};

/** Flag each block with whether its id reached an element in the output. */
export function markAnchorable(blocks: BlockMap, rendered: Set<string> | undefined): BlockMap {
  const present = rendered ?? new Set<string>();
  for (const block of blocks) {
    block.anchorable = present.has(block.id);
  }
  return blocks;
}

/**
 * Collect the block ids present in an already-serialized HTML string.
 *
 * The asciidoc pipeline hands its `BlockMap` back from a walk of the
 * asciidoctor AST that finished before the rehype passes ran, so there is
 * no `file.data` to read the set out of; parsing the attributes back out
 * of the output answers the same question.
 */
export function renderedBlockIdsFromHtml(html: string): Set<string> {
  const found = new Set<string>();
  const re = /\bdata-(?:sub)?block="([^"]*)"/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    found.add(decodeAttr(m[1]!));
  }
  return found;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
