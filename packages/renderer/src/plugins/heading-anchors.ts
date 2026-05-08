import type { Element, Root } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * For every heading that has an `id`, prepend a self-linking anchor so
 * themes can show a permalink icon on hover (GitHub/GitLab-style).
 *
 * Runs after remark-rehype so it doesn't contaminate the upstream mdast
 * with HTML noise (block IDs would otherwise include the anchor markup
 * in their hash input).
 */
export const rehypeHeadingAnchors: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      if (!isHeading(node.tagName)) return;
      const id = getStringProp(node, 'id');
      if (!id) return;

      const text = hastToString(node).trim();
      const anchor: Element = {
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['heading-anchor'],
          href: `#${id}`,
          ariaLabel: `Permalink to \u201C${text}\u201D`,
        },
        children: [{ type: 'text', value: '#' }],
      };
      node.children.unshift(anchor);
    });
  };
};

function isHeading(tag: string): boolean {
  return (
    tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6'
  );
}

function getStringProp(node: Element, key: string): string | null {
  const v = node.properties?.[key];
  return typeof v === 'string' ? v : null;
}
