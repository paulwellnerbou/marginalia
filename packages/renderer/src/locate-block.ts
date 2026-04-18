import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Root, RootContent } from 'mdast';

/**
 * Locate a top-level block in markdown source by its content-hash ID.
 *
 * The hash MUST match `hashBlock(kind, normalize(mdastToString(node)))` as
 * computed by the remark-block-ids plugin — keep the two implementations in
 * sync.
 */
export interface BlockSourceRange {
  start: number;
  end: number;
  kind: string;
  text: string;
}

export function locateBlockSource(
  markdown: string,
  blockId: string,
): BlockSourceRange | null {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdown) as Root;

  for (const node of tree.children) {
    const text = normalize(mdastToString(node));
    if (!text && node.type !== 'thematicBreak') continue;
    const id = hashBlock(node.type, text);
    if (id !== blockId) continue;
    const pos = (node as RootContent).position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) {
      return null;
    }
    return {
      start: pos.start.offset,
      end: pos.end.offset,
      kind: node.type,
      text,
    };
  }
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

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
