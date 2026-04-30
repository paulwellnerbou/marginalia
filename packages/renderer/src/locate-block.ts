import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { ListItem, Root, RootContent, TableCell } from 'mdast';
import { computeSubBlockId, hashBlock, normalizeBlockText } from './block-ids-shared.js';

/**
 * Locate a top-level block OR a sub-block (list item / table cell) in
 * markdown source by its content-hash ID.
 *
 * Id derivation lives in `block-ids-shared.ts` and is shared with the
 * `remarkBlockIds` plugin, so the two walks can't drift.
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
    const text = normalizeBlockText(mdastToString(node));
    if (!text && node.type !== 'thematicBreak') continue;
    const pos = (node as RootContent).position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) continue;
    const id = hashBlock(node.type, text);
    // First occurrence wins — same block text hashed identically would shadow.
    if (!out.has(id)) {
      out.set(id, { start: pos.start.offset, end: pos.end.offset, kind: node.type, text });
    }
  }

  // Sub-blocks: list items and table cells. The counts map MUST stay in
  // sync with the plugin's walk (same tree, same visit order) so the
  // plugin's emitted `data-subblock` ids can be round-tripped back to
  // their own source range — including duplicate-content siblings, each
  // of which gets its own `#n` suffix via computeSubBlockId.
  const subBlockCounts = new Map<string, number>();
  visit(tree, (node) => {
    if (node.type !== 'listItem' && node.type !== 'tableCell') return;
    const text = normalizeBlockText(mdastToString(node));
    if (!text) return;
    const pos = node.position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) return;
    const range = narrowedRange(node, pos.start.offset, pos.end.offset);
    const id = computeSubBlockId(node.type, text, subBlockCounts);
    // Unique per occurrence, so no `has` guard — every duplicate gets its
    // own entry pointing at its own source range.
    out.set(id, { start: range.start, end: range.end, kind: node.type, text });
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
  node: ListItem | TableCell,
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

/**
 * Resolve a multi-block source range from two block IDs. Used by the
 * "propose edit" flow when a selection spans more than one top-level
 * block. The returned range covers everything from the earlier block's
 * start to the later block's end (in source order), inclusive of any
 * inter-block whitespace, so a server-side splice replaces the whole
 * span atomically.
 *
 * Returns the start block's range when `endId` is null/equal to start.
 * Returns null if either id is missing — callers treat that as orphaned.
 *
 * Note on `text`: for single-block ranges, `BlockSourceRange.text` is
 * the *normalized* block text (used for ID hashing). A merged
 * multi-block span has no single normalized text — it's a raw source
 * slice plus inter-block whitespace — so we set `text` to '' here and
 * leave it to callers to slice the source themselves with start/end.
 */
export function locateBlockRange(
  markdown: string,
  startId: string,
  endId: string | null,
): BlockSourceRange | null {
  const all = locateAllBlocks(markdown);
  const a = all.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return a;
  const b = all.get(endId);
  if (!b) return null;
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  return { start, end, kind: 'multi', text: '' };
}
