import type { Image, Link, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import type { AssetRef, Warning } from '../types.js';

/**
 * Record every image and link reference so the viewer can enumerate
 * attached assets and so the server can warn about broken refs.
 *
 * Also emits `missing-alt` warnings for images without alt text.
 */
export const remarkAssetCollector: Plugin<[], Root> = () => {
  return (tree, file) => {
    const assets: AssetRef[] = [];
    const warnings: Warning[] = ((file.data as { warnings?: Warning[] }).warnings ??= []);

    visit(tree, 'image', (node: Image) => {
      const ref: AssetRef = {
        src: node.url,
        alt: node.alt ?? '',
        kind: 'image',
      };
      if (node.position?.start.line !== undefined) {
        ref.line = node.position.start.line;
      }
      assets.push(ref);
      if (!node.alt || node.alt.trim() === '') {
        const w: Warning = {
          kind: 'missing-alt',
          message: `image ${node.url} is missing alt text`,
        };
        if (node.position?.start.line !== undefined) w.line = node.position.start.line;
        warnings.push(w);
      }
    });

    visit(tree, 'link', (node: Link) => {
      const ref: AssetRef = { src: node.url, alt: null, kind: 'link' };
      if (node.position?.start.line !== undefined) {
        ref.line = node.position.start.line;
      }
      assets.push(ref);
    });

    (file.data as { assets?: AssetRef[] }).assets = assets;
  };
};
