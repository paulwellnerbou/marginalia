import type { Root, RootContent } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import {
  computeSubBlockId,
  hashBlock,
  normalizeBlockText,
  SectionTracker,
} from '../block-ids-shared.js';
import type { BlockInfo, BlockMap } from '../types.js';
import type { BlockOffsets } from './block-elements.js';

/**
 * Attach a stable content-hash ID to every top-level block, and a secondary
 * id to every sub-block that an edit proposal can target individually
 * (`listItem`, `tableCell`). Top-level ids are written as
 * `data-block="<id>"`, sub-block ids as `data-subblock="<id>"`.
 *
 * Both kinds of ids participate in the exported `blocks` map so the
 * server's re-anchoring pass can find a comment anchored to a list item
 * (or table cell) by id and keep its `link_status` as `'linked'` — the
 * map is used by `reanchor()` after every save. Sub-blocks are emitted
 * directly after their enclosing top-level block (rather than in a
 * separate trailing pass) and inherit its heading context, so fallback
 * scoring in reanchor still has section affinity to work with when an
 * id-based lookup fails.
 */
export const remarkBlockIds: Plugin<[], Root> = () => {
  return (tree, file) => {
    const blocks: BlockMap = [];
    // Footnote definitions are re-homed into a generated <section> that
    // keeps their source position but not their hProperties, so their ids
    // travel to `rehypeFootnoteBlockIds` out of band, keyed by offset.
    const footnoteBlockOffsets: BlockOffsets = new Map();
    const sections = new SectionTracker();
    // Sub-block ids share one doc-wide counter so duplicate-content
    // siblings (two cells reading "Yes", for instance) get distinct
    // ids. `locateBlocks` walks the same tree in the same order
    // and uses the same counter, so the ids round-trip back to source
    // ranges. Otherwise selections inside a later duplicate would
    // walk past the cell and resolve up to the enclosing table.
    const subBlockCounts = new Map<string, number>();
    for (const node of tree.children) {
      const text = normalizeBlockText(mdastToString(node));
      if (!text && node.type !== 'thematicBreak') continue;

      if (node.type === 'heading') sections.enterHeading(node.depth, text);
      const { headingPath, sectionIndex, sectionIndexPath } = sections.next();

      const id = hashBlock(node.type, text);
      const info: BlockInfo = {
        id,
        kind: node.type,
        text,
        headingPath,
        sectionIndex,
        sectionIndexPath,
        // Set for real once the tree is rendered and we can see which ids
        // made it onto an element.
        anchorable: false,
      };
      if (node.type === 'heading') {
        const headingId = slugOf(node);
        if (headingId) info.headingId = headingId;
      }
      blocks.push(info);

      attachDataAttr(node, 'data-block', id);
      const start = node.position?.start?.offset;
      if (node.type === 'footnoteDefinition' && start !== undefined) {
        footnoteBlockOffsets.set(start, id);
      }

      // Sub-blocks within this top-level block inherit its section
      // context. With a real headingPath / sectionIndexPath, fallback
      // re-anchoring can score a list-item candidate by section
      // affinity and pick "the list item under the same heading"
      // over a verbatim quote elsewhere in the doc.
      visit(node, (sub) => {
        if (sub.type !== 'listItem' && sub.type !== 'tableCell') return;
        const subText = normalizeBlockText(mdastToString(sub));
        if (!subText) return;
        const subId = computeSubBlockId(sub.type, subText, subBlockCounts);
        attachDataAttr(sub as RootContent, 'data-subblock', subId);
        blocks.push({
          id: subId,
          kind: sub.type,
          text: subText,
          headingPath: [...headingPath],
          sectionIndex,
          sectionIndexPath: [...sectionIndexPath],
          anchorable: false,
        });
      });
    }
    const data = file.data as { blocks?: BlockMap; footnoteBlockOffsets?: BlockOffsets };
    data.blocks = blocks;
    data.footnoteBlockOffsets = footnoteBlockOffsets;
  };
};

/** The `id` `remarkSlugger` left on the heading's hProperties, if any. */
function slugOf(node: RootContent): string | null {
  const data = (node as { data?: { hProperties?: Record<string, unknown> } }).data;
  const id = data?.hProperties?.['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function attachDataAttr(node: RootContent, attr: 'data-block' | 'data-subblock', id: string): void {
  const nodeWithData = node as unknown as {
    data?: { hProperties?: Record<string, unknown> };
  };
  nodeWithData.data ??= {};
  const data = nodeWithData.data;
  data.hProperties ??= {};
  const props = data.hProperties;
  props[attr] = id;
}
