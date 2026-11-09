import type { Element, ElementContent, Root } from 'hast';
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

/**
 * The source span of the section a heading opens, as whole elements: from
 * the heading — or the wrapper it leads, `<section><h2>` — through every
 * following sibling that ends before `limit` (the next same-or-higher
 * heading's start, or the source end). Splicing an edited copy back can
 * then never leave a wrapper half open, and trailing content without text
 * of its own (an image, a divider SVG) stays with its section.
 *
 * Content in a sibling that also holds the next heading belongs to
 * neither section. Null when no element starts at `headingStart`.
 */
export function htmlSectionSpan(
  source: string,
  headingStart: number,
  limit: number,
): { start: number; end: number } | null {
  const tree = parseHtmlSource(source);
  const found = findAt(tree, headingStart, null);
  if (!found) return null;
  let { node, parent } = found;
  while (
    parent &&
    !CONTAINER_ROOTS.has(parent.node.tagName) &&
    firstContentChild(parent.node) === node &&
    (sourceEnd(parent.node) ?? Number.POSITIVE_INFINITY) <= limit
  ) {
    node = parent.node;
    parent = parent.parent;
  }
  const start = node.position?.start?.offset ?? headingStart;
  let end = sourceEnd(node) ?? start;
  const siblings = parent?.node.children ?? [];
  for (let i = siblings.indexOf(node) + 1; i < siblings.length; i++) {
    const sibling = siblings[i]!;
    const siblingEnd =
      sibling.type === 'element' ? sourceEnd(sibling) : sibling.position?.end?.offset;
    if (siblingEnd === undefined || siblingEnd > limit) break;
    if (sibling.type === 'element' || sibling.type === 'text') end = Math.max(end, siblingEnd);
  }
  // Whitespace between the last element and the limit stays outside.
  while (end > start && /\s/u.test(source[end - 1] ?? '')) end--;
  return { start, end };
}

interface Located {
  node: Element;
  parent: Located | null;
}

const CONTAINER_ROOTS = new Set(['body', 'html']);

function findAt(parent: Root | Element, offset: number, chain: Located | null): Located | null {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    const here: Located = { node: child, parent: chain };
    if (child.position?.start?.offset === offset && !CONTAINER_ROOTS.has(child.tagName)) {
      return here;
    }
    const start = child.position?.start?.offset;
    const end = sourceEnd(child);
    if (start !== undefined && end !== undefined && (offset < start || offset >= end)) continue;
    const found = findAt(child, offset, here);
    if (found) return found;
  }
  return null;
}

/** The first child that is an element or non-blank text. */
function firstContentChild(el: Element): ElementContent | undefined {
  return el.children.find(
    (c) => c.type === 'element' || (c.type === 'text' && c.value.trim() !== ''),
  );
}
