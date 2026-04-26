import type { Plugin } from 'unified';
import type { Root, RootContent } from 'mdast';
import { visit } from 'unist-util-visit';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { BlockInfo, BlockMap } from '../types.js';
import { computeSubBlockId, hashBlock, normalizeBlockText } from '../block-ids-shared.js';

/**
 * Attach a stable content-hash ID to every top-level block, and a secondary
 * id to every sub-block that an edit proposal can target individually
 * (`listItem`, `tableCell`). Top-level ids are written as
 * `data-block="<id>"`, sub-block ids as `data-subblock="<id>"`.
 *
 * Both kinds of ids participate in the exported `blocks` map so the
 * server's re-anchoring pass can find a comment anchored to a list item
 * (or table cell) by id and keep its `link_status` as `'linked'` — the
 * map is used by `reanchor()` after every save. Sub-blocks are appended
 * after all top-level entries so existing callers that index `blocks[0]`
 * etc. still see top-level blocks at the front.
 */
export const remarkBlockIds: Plugin<[], Root> = () => {
  return (tree, file) => {
    const blocks: BlockMap = [];
    const stack: Array<{ level: number; text: string }> = [];
    const sectionCounts = new Map<string, number>();
    for (const node of tree.children) {
      const text = normalizeBlockText(mdastToString(node));
      if (!text && node.type !== 'thematicBreak') continue;

      if (node.type === 'heading') {
        while (stack.length && stack[stack.length - 1]!.level >= node.depth) {
          stack.pop();
        }
        stack.push({ level: node.depth, text });
      }

      const headingPath = stack.map((s) => s.text);
      // Counters for every ancestor prefix (including the empty root prefix).
      // sectionIndexPath[k] is this block's position within the section
      // rooted at headingPath[0..k-1]; sectionIndexPath[last] is the
      // innermost-section position.
      const sectionIndexPath: number[] = [];
      for (let k = 0; k <= headingPath.length; k++) {
        const prefixKey = headingPath.slice(0, k).join('\u0000');
        const n = sectionCounts.get(prefixKey) ?? 0;
        sectionIndexPath.push(n);
        sectionCounts.set(prefixKey, n + 1);
      }
      const sectionIndex = sectionIndexPath[sectionIndexPath.length - 1]!;

      const id = hashBlock(node.type, text);
      const info: BlockInfo = {
        id,
        kind: node.type,
        text,
        headingPath,
        sectionIndex,
        sectionIndexPath,
      };
      blocks.push(info);

      attachDataAttr(node, 'data-block', id);
    }
    (file.data as { blocks?: BlockMap }).blocks = blocks;

    // Sub-block annotation — list items and table cells. Duplicate-content
    // siblings (two cells reading "Yes", for instance) MUST get distinct
    // ids, otherwise selections inside a later duplicate walk past the
    // cell and resolve up to the enclosing table — the "Propose edit"
    // button then appears at the table's corner and opens the whole
    // table's source. `computeSubBlockId` tracks occurrence order and
    // suffixes duplicates `#2`, `#3`, …. The `counts` map is shared
    // across the whole document so `locateAllBlocks`, walking the same
    // tree in the same order, produces identical ids.
    //
    // Sub-block entries are also appended to `blocks` so server-side
    // re-anchoring can find a comment by sub-block id. Heading context
    // is left empty — the id-based lookup is the primary path; the
    // fuzzy section-affinity scoring only kicks in when the id is no
    // longer present (which for sub-blocks usually means the list item
    // was edited and the comment becomes orphaned regardless).
    const counts = new Map<string, number>();
    visit(tree, (node) => {
      if (node.type !== 'listItem' && node.type !== 'tableCell') return;
      const text = normalizeBlockText(mdastToString(node));
      if (!text) return;
      const id = computeSubBlockId(node.type, text, counts);
      attachDataAttr(node as RootContent, 'data-subblock', id);
      blocks.push({
        id,
        kind: node.type,
        text,
        headingPath: [],
        sectionIndex: 0,
        sectionIndexPath: [0],
      });
    });
  };
};

function attachDataAttr(
  node: RootContent,
  attr: 'data-block' | 'data-subblock',
  id: string,
): void {
  const nodeWithData = node as unknown as {
    data?: { hProperties?: Record<string, unknown> };
  };
  const data = (nodeWithData.data ??= {});
  const props = (data.hProperties ??= {});
  props[attr] = id;
}

