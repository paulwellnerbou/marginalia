import { joinSpanQuote } from '@marginalia/renderer';
import type { CommentAnchor } from './api.js';
import { anchorIdOf, elementsIntersectingRange } from './block-span.js';

const CONTEXT_LEN = 32;

/** One covered block's contribution to an anchor. */
interface BlockSlice {
  el: HTMLElement;
  blockId: string;
  /** Normalized selected text inside `el`. */
  quote: string;
  /** Where `quote` starts within `el`'s normalized text. */
  startOffset: number;
  /** `el`'s full normalized text, for prefix/suffix context. */
  blockText: string;
}

/**
 * Capture the current window selection as a CommentAnchor, if the selection
 * is non-empty and overlaps at least one element under `root` carrying a
 * `data-block` / `data-subblock` attribute. Returns null otherwise.
 *
 * A selection covering several blocks produces a span anchor: `block_id`
 * and `end_block_id` are its first and last blocks, `quote` holds each
 * covered block's selected text joined by the renderer's span separator,
 * and the offsets are into the first and last block respectively.
 *
 * Whitespace is normalized (collapsed to single spaces) so the quote matches
 * what the server stored in its block map — the renderer applies the same
 * normalization when hashing block contents.
 */
export function captureSelection(root: HTMLElement): CommentAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  // Blocks the selection only touches at a boundary (a triple-click that
  // ends at offset 0 of the next paragraph) clamp to an empty range and
  // drop out here, so they never extend the span.
  let slices = elementsIntersectingRange(root, range)
    .map((el) => sliceBlock(el, range))
    .filter((s): s is BlockSlice => s !== null);

  if (slices.length === 0) {
    const fallback =
      closestBlock(range.startContainer) ??
      closestBlock(range.commonAncestorContainer) ??
      blockAtElementOffset(range.startContainer, range.startOffset);
    const slice = fallback ? sliceBlock(fallback, range) : null;
    if (!slice) return null;
    slices = [slice];
  }

  const first = slices[0]!;
  const last = slices[slices.length - 1]!;
  const endOffset = last.startOffset + last.quote.length;

  const prefix = first.blockText.slice(
    Math.max(0, first.startOffset - CONTEXT_LEN),
    first.startOffset,
  );
  const suffix = last.blockText.slice(
    endOffset,
    Math.min(last.blockText.length, endOffset + CONTEXT_LEN),
  );

  // Section context is computed against the enclosing top-level block
  // even when the comment is anchored to a sub-block — heading path /
  // section index are properties of the section the block lives in.
  const sectionTarget = first.el.dataset.block ? first.el : closestTopBlock(first.el);
  const section = sectionTarget
    ? computeSectionContext(root, sectionTarget)
    : { headingPath: [] as string[], sectionIndex: 0, sectionIndexPath: [0] };
  return {
    block_id: first.blockId,
    end_block_id: slices.length > 1 ? last.blockId : null,
    quote: joinSpanQuote(slices.map((s) => s.quote)),
    prefix,
    suffix,
    start_offset: first.startOffset,
    end_offset: endOffset,
    heading_path: section.headingPath,
    section_index: section.sectionIndex,
    section_index_path: section.sectionIndexPath,
  };
}

/**
 * Clamp `range` to `el` and describe what it selects there. Returns null
 * when the clamped range is empty — either because the two are disjoint
 * or because they only meet at a boundary.
 */
function sliceBlock(el: HTMLElement, range: Range): BlockSlice | null {
  // Prefer the more specific sub-block id (list item, table cell, …)
  // over the enclosing block id, so a comment on one list item anchors
  // to that item rather than to the entire list.
  const blockId = anchorIdOf(el);
  if (!blockId) return null;

  const blockRange = document.createRange();
  blockRange.selectNodeContents(el);
  const clamped = range.cloneRange();
  if (clamped.compareBoundaryPoints(Range.START_TO_START, blockRange) < 0) {
    clamped.setStart(blockRange.startContainer, blockRange.startOffset);
  }
  if (clamped.compareBoundaryPoints(Range.END_TO_END, blockRange) > 0) {
    clamped.setEnd(blockRange.endContainer, blockRange.endOffset);
  }
  if (clamped.collapsed) return null;

  const clampedText = clamped.toString();
  const quote = normalizeWs(clampedText);
  if (!quote) return null;

  const blockText = normalizeWs(el.textContent ?? '');

  // DOM offsets are per-text-node; convert to offsets within the block's
  // normalized text by measuring the length of the un-selected prefix.
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(clamped.startContainer, clamped.startOffset);
  const rawStart = preRange.toString().length;

  // Offsets into the normalized string aren't exactly `rawStart` because
  // whitespace was collapsed, but we can approximate by locating `quote`
  // in the normalized block text starting near rawStart.
  const approxIdx = Math.max(0, rawStart - 10);
  let startOffset = blockText.indexOf(quote, approxIdx);
  if (startOffset < 0) startOffset = blockText.indexOf(quote);
  if (startOffset < 0) startOffset = 0;

  return { el, blockId, quote, startOffset, blockText };
}

/**
 * Replay the server-side block-ids walk in the DOM: iterate sibling blocks
 * up to (and including) `target`, maintaining a heading stack and a
 * per-section-path counter. Returns the path + index for `target`.
 *
 * Kept in sync with packages/renderer/src/plugins/block-ids.ts.
 */
function computeSectionContext(
  root: HTMLElement,
  target: HTMLElement,
): { headingPath: string[]; sectionIndex: number; sectionIndexPath: number[] } {
  // Block-IDs plugin only annotates top-level mdast children, which render as
  // direct descendants of the rendered container. Nested [data-block] would
  // throw off the stack, so scope to direct children — `collectTopLevelBlocks`
  // also steps through `.collapse-section[-inner]` wrappers transparently.
  const blocks = collectTopLevelBlocks(root);
  const stack: Array<{ level: number; text: string }> = [];
  const counts = new Map<string, number>();
  let result = { headingPath: [] as string[], sectionIndex: 0, sectionIndexPath: [0] };
  for (const el of blocks) {
    const text = normalizeWs(el.textContent ?? '');
    const headingMatch = /^H([1-6])$/.exec(el.tagName);
    if (headingMatch) {
      const depth = Number(headingMatch[1]);
      while (stack.length && stack[stack.length - 1]!.level >= depth) stack.pop();
      stack.push({ level: depth, text });
    }
    const headingPath = stack.map((s) => s.text);
    const sectionIndexPath: number[] = [];
    for (let k = 0; k <= headingPath.length; k++) {
      const key = headingPath.slice(0, k).join('\u0000');
      const n = counts.get(key) ?? 0;
      sectionIndexPath.push(n);
      counts.set(key, n + 1);
    }
    const sectionIndex = sectionIndexPath[sectionIndexPath.length - 1]!;
    if (el === target) {
      result = { headingPath, sectionIndex, sectionIndexPath };
      break;
    }
  }
  return result;
}

/** `[data-block]` descendants in document order, treating known
 * structural containers as transparent: the runtime collapse
 * wrappers (`.collapse-section[-inner]`) and AsciiDoc's section
 * shape (`#content`, `#preamble`, `.sectN`, `.sectionbody`).
 * Without those, comments captured inside a folded section or
 * inside any AsciiDoc body would lose their heading-path metadata.
 */
const TRANSPARENT_CONTAINER_RE =
  /(?:^|\s)(?:collapse-section|collapse-section-inner|sect\d+|sectionbody)(?:\s|$)/;
function collectTopLevelBlocks(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute('data-block')) {
      out.push(child);
      continue;
    }
    if (
      child.id === 'content' ||
      child.id === 'preamble' ||
      TRANSPARENT_CONTAINER_RE.test(child.className)
    ) {
      out.push(...collectTopLevelBlocks(child));
    }
  }
  return out;
}

export function selectionRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  // Use getClientRects()[0] instead of getBoundingClientRect() so that when a
  // selection wraps across multiple lines, we only consider the bounding box
  // of the first line. This prevents the button from jumping to the center
  // of the full container width.
  const rects = sel.getRangeAt(0).getClientRects();
  if (rects.length === 0) return null;
  const rect = rects[0];
  if (!rect) return null;

  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

function closestBlock(node: Node): HTMLElement | null {
  // Returns the nearest commentable ancestor — either a top-level block
  // (`data-block`) or a fine-grained sub-block (`data-subblock` on list
  // items / table cells). Mirrors the proposal toolbar's resolution so
  // a comment on a list-item anchors to the `<li>`, not the `<ul>`.
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && (n.dataset.subblock || n.dataset.block)) return n;
    n = n.parentNode;
  }
  return null;
}

function closestTopBlock(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && n.dataset.block) return n;
    n = n.parentNode;
  }
  return null;
}

function blockAtElementOffset(container: Node, offset: number): HTMLElement | null {
  if (!(container instanceof Element)) return null;
  const child = container.childNodes[offset] ?? container.childNodes[offset - 1];
  return child ? closestBlock(child) : null;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}
