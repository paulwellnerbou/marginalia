import { parseHtmlSource, sourceEnd, walkHtmlBlocks } from './html-blocks.js';
import { addOccurrence, type BlockSourceRange, type LocatedBlocks } from './locate-block.js';

/**
 * HTML twin of `locateBlocks`: every block's id → the source range of its
 * element, start tag to end tag. An edit proposal on a block therefore
 * replaces the element's whole markup, so the author can change its class
 * as well as its text.
 */
export function locateBlocksHtml(source: string): LocatedBlocks {
  const out: LocatedBlocks = { byId: new Map(), occurrences: new Map() };
  for (const block of walkHtmlBlocks(parseHtmlSource(source))) {
    const start = block.node.position?.start?.offset;
    const end = sourceEnd(block.node);
    if (start === undefined || end === undefined) continue;
    const range: BlockSourceRange = { start, end, kind: block.kind, text: block.text };
    addOccurrence(out, block.id, range, block.section);
  }
  return out;
}

/** Every block's id → source range, first occurrence winning. */
export function locateAllBlocksHtml(source: string): Map<string, BlockSourceRange> {
  return locateBlocksHtml(source).byId;
}

/**
 * Span of two blocks, earlier start to later end. Any two blocks may be
 * merged: unlike a Markdown table row, HTML markup between them survives
 * a splice as long as the replacement keeps it, and the composer shows it.
 */
export function locateBlockRangeHtml(
  source: string,
  startId: string,
  endId: string | null,
): BlockSourceRange | null {
  const all = locateAllBlocksHtml(source);
  const a = all.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return a;
  const b = all.get(endId);
  if (!b) return null;
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    kind: 'multi',
    text: '',
  };
}
