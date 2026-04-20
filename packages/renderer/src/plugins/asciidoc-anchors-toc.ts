import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import { visit } from 'unist-util-visit';
import type { Anchor } from '../types.js';

/**
 * Harvest every heading (`h1`..`h6`) into `file.data.anchors` in document
 * order. Asciidoctor's default converter already slugifies heading ids via
 * `sectids=true`, so we only need to read them back. `buildToc()` runs
 * downstream on the returned list.
 */
export const rehypeAsciidocAnchorsToc: Plugin<[], Root> = () => {
  return (tree, file) => {
    const anchors: Anchor[] = [];
    visit(tree, 'element', (node: Element) => {
      const m = /^h([1-6])$/.exec(node.tagName);
      if (!m) return;
      const level = Number.parseInt(m[1]!, 10);
      const id = getId(node);
      if (!id) return;
      const text = hastToString(node).trim();
      anchors.push({ level, text, id });
    });
    (file.data as { anchors?: Anchor[] }).anchors = anchors;
  };
};

function getId(node: Element): string | null {
  const id = node.properties?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (Array.isArray(id) && typeof id[0] === 'string') return id[0];
  return null;
}
