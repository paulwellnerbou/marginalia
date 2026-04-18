import type { Plugin } from 'unified';
import type { Root, RootContent } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { BlockInfo, BlockMap } from '../types.js';

/**
 * Attach a stable content-hash ID to every top-level block.
 *
 * The ID survives edits elsewhere in the document and changes when the block
 * itself changes. Written to the rendered element as `data-block="<id>"` and
 * exposed via file.data.blocks for the comment-anchoring system.
 */
export const remarkBlockIds: Plugin<[], Root> = () => {
  return (tree, file) => {
    const blocks: BlockMap = [];
    const stack: Array<{ level: number; text: string }> = [];
    const sectionCounts = new Map<string, number>();
    for (const node of tree.children) {
      const text = normalize(mdastToString(node));
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

      attachDataAttr(node, id);
    }
    (file.data as { blocks?: BlockMap }).blocks = blocks;
  };
};

function attachDataAttr(node: RootContent, id: string): void {
  const nodeWithData = node as unknown as {
    data?: { hProperties?: Record<string, unknown> };
  };
  const data = (nodeWithData.data ??= {});
  const props = (data.hProperties ??= {});
  props['data-block'] = id;
}

/**
 * Normalize for hashing: collapse whitespace, trim. We deliberately do NOT
 * lowercase here — capitalization changes are meaningful block changes.
 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Short content hash. 64 bits of FNV-1a is plenty for per-document
 * uniqueness; the IDs are local to one document. BigInt is fine here —
 * block counts are small, not hot-path.
 */
function hashBlock(kind: string, text: string): string {
  const input = `${kind}\u0000${text}`;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
