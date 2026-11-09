import type { Element, ElementContent, Root } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * Mark paragraphs that hold nothing but images as `data-block-kind="image"`.
 *
 * Markdown has no block image: `![](x.png)` on a line of its own is a
 * paragraph with an inline image in it. The viewer lets such a paragraph
 * grow wider than the text column, which it must not do to one that
 * merely contains an inline icon in running text — and CSS can't tell the
 * two apart, because `:only-child` ignores text nodes.
 *
 * Runs after sanitizing, which would otherwise strip the attribute.
 */
export const rehypeMarkImageParagraphs: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'p') return;
    if (!isImageOnly(node.children, true)) return;
    node.properties = { ...node.properties, dataBlockKind: 'image' };
  });
};

function isImageOnly(children: ElementContent[], allowLinks: boolean): boolean {
  let images = 0;
  for (const child of children) {
    if (child.type === 'text') {
      if (child.value.trim() !== '') return false;
      continue;
    }
    if (child.type !== 'element') continue;
    if (child.tagName === 'img') {
      images++;
    } else if (child.tagName === 'br') {
      // Images stacked with hard line breaks are still a run of images.
    } else if (allowLinks && child.tagName === 'a' && isImageOnly(child.children, false)) {
      images++;
    } else {
      return false;
    }
  }
  return images > 0;
}
