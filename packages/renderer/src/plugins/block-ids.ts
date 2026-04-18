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
 * `data-block="<id>"` and feed the comment-anchoring system; sub-block ids
 * are written as `data-subblock="<id>"` and are used by proposal capture
 * only — they do NOT participate in the exported `blocks` map, so existing
 * comment behavior is unchanged.
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
    const counts = new Map<string, number>();
    visit(tree, (node) => {
      if (node.type !== 'listItem' && node.type !== 'tableCell') return;
      const text = normalizeBlockText(mdastToString(node));
      if (!text) return;
      const id = computeSubBlockId(node.type, text, counts);
      attachDataAttr(node as RootContent, 'data-subblock', id);
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

