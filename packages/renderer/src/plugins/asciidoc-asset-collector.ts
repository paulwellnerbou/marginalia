import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';
import type { AssetRef } from '../types.js';

/**
 * Collect `<img src>` and `<a href>` references into `file.data.assets` to
 * mirror the markdown `remarkAssetCollector`. Line numbers aren't
 * available post-HTML, so `line` is left undefined — the markdown path
 * fills it from the mdast position.
 */
export const rehypeAsciidocAssetCollector: Plugin<[], Root> = () => {
  return (tree, file) => {
    const assets: AssetRef[] = [];
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'img') {
        const src = stringAttr(node, 'src');
        if (!src) return;
        assets.push({ src, alt: stringAttr(node, 'alt'), kind: 'image' });
        return;
      }
      if (node.tagName === 'a') {
        const href = stringAttr(node, 'href');
        if (!href) return;
        assets.push({ src: href, alt: null, kind: 'link' });
      }
    });
    (file.data as { assets?: AssetRef[] }).assets = assets;
  };
};

function stringAttr(node: Element, name: string): string | null {
  const v = node.properties?.[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}
