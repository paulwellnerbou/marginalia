import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Root, RootContent } from 'mdast';

/**
 * Locate a top-level block OR a sub-block (list item / table cell) in
 * markdown source by its content-hash ID.
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

/** Build a map of every top-level block's id → source range. Use this when
 *  resolving many blocks against the same document — callers that resolve a
 *  single id may use `locateBlockSource` instead. */
export function locateAllBlocks(markdown: string): Map<string, BlockSourceRange> {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdown) as Root;

  const out = new Map<string, BlockSourceRange>();

  // Top-level blocks — match remark-block-ids' top-level walk.
  for (const node of tree.children) {
    const text = normalize(mdastToString(node));
    if (!text && node.type !== 'thematicBreak') continue;
    const pos = (node as RootContent).position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) continue;
    const id = hashBlock(node.type, text);
    // First occurrence wins — same block text hashed identically would shadow.
    if (!out.has(id)) {
      out.set(id, { start: pos.start.offset, end: pos.end.offset, kind: node.type, text });
    }
  }

  // Sub-blocks: list items and table cells. Mirrors the secondary walk in
  // remark-block-ids so `data-subblock` ids round-trip back to source.
  visit(tree, (node) => {
    if (node.type !== 'listItem' && node.type !== 'tableCell') return;
    const text = normalize(mdastToString(node));
    if (!text) return;
    const pos = node.position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) return;
    const range = narrowedRange(node, pos.start.offset, pos.end.offset);
    const id = hashBlock(node.type, text);
    if (!out.has(id)) {
      out.set(id, { start: range.start, end: range.end, kind: node.type, text });
    }
  });

  return out;
}

/**
 * For a tableCell, the mdast `position` spans from the preceding `|` up
 * to (and for the final cell, including) the trailing `|`, plus the
 * surrounding whitespace — e.g. `"| h1 "` or `"| b  |"`. We don't want
 * the user to see or accidentally break the pipes, so narrow the range
 * to the text the cell actually contains (from the first child's start
 * to the last child's end).
 *
 * For an empty cell (no children), fall back to a zero-length range
 * positioned just after the leading pipe + optional space so a
 * proposed replacement inserts cleanly between the existing pipes.
 *
 * List items don't need narrowing — their position already starts at
 * the bullet and the bullet is part of what the user edits.
 */
function narrowedRange(
  node: { type: string; children?: Array<{ position?: { start: { offset?: number }; end: { offset?: number } } }> },
  start: number,
  end: number,
): { start: number; end: number } {
  if (node.type !== 'tableCell') return { start, end };
  const children = node.children ?? [];
  const first = children[0]?.position;
  const last = children[children.length - 1]?.position;
  if (
    first &&
    last &&
    first.start.offset !== undefined &&
    last.end.offset !== undefined
  ) {
    return { start: first.start.offset, end: last.end.offset };
  }
  // Empty cell: return a zero-length insertion point just inside the
  // pipes. We don't know the exact column without re-scanning, so point
  // to the middle of the cell span; the server replaces [start, end)
  // with proposed text, which for an empty cell means the text is
  // inserted between the surrounding whitespace untouched.
  const mid = Math.floor((start + end) / 2);
  return { start: mid, end: mid };
}

export function locateBlockSource(
  markdown: string,
  blockId: string,
): BlockSourceRange | null {
  return locateAllBlocks(markdown).get(blockId) ?? null;
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
