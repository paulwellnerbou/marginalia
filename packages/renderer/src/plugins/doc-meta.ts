import type { Root, RootContent } from 'mdast';
import type { Plugin } from 'unified';
import { DOC_META_ATTR, findMarkdownDocMetaRegions } from '../doc-meta.js';

/**
 * Wrap each summary / about region in `<section class="doc-meta"
 * data-doc-meta="…">` and drop its marker comments, so the viewer has one
 * element to fold.
 *
 * Runs after `remarkBlockIds`: that pass walks the root's children flat to
 * number blocks the way `locateBlocks` does on an unwrapped parse, so the
 * wrapper has to come later or the two would disagree.
 */
export const remarkDocMetaSections: Plugin<[], Root> = () => {
  return (tree) => {
    const regions = findMarkdownDocMetaRegions(tree.children);
    for (const region of regions.reverse()) {
      const inner = tree.children.slice(region.open + 1, region.close);
      const replacement: RootContent[] =
        inner.length === 0
          ? []
          : [
              {
                type: 'docMetaSection',
                children: inner,
                data: {
                  hName: 'section',
                  hProperties: { className: ['doc-meta'], [DOC_META_ATTR]: region.kind },
                },
              } as unknown as RootContent,
            ];
      tree.children.splice(region.open, region.close - region.open + 1, ...replacement);
    }
  };
};
