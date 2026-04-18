import type { CommentAnchor } from './api.js';

const CONTEXT_LEN = 32;

/**
 * Capture the current window selection as a CommentAnchor, if the selection
 * is non-empty and falls inside an element under `root` carrying a
 * `data-block` attribute. Returns null otherwise.
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

  const blockEl = closestBlock(range.commonAncestorContainer);
  if (!blockEl) return null;
  const blockId = blockEl.dataset.block;
  if (!blockId) return null;

  const blockText = normalizeWs(blockEl.textContent ?? '');
  const quote = normalizeWs(range.toString());
  if (!quote) return null;

  // DOM offsets are per-text-node; convert to offsets within the block's
  // normalized text by measuring the length of the un-selected prefix.
  const preRange = document.createRange();
  preRange.selectNodeContents(blockEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const rawStart = preRange.toString().length;
  const rawEnd = rawStart + range.toString().length;

  // Offsets into the normalized string aren't exactly `rawStart` because
  // whitespace was collapsed, but we can approximate by locating `quote`
  // in the normalized block text starting near rawStart.
  const approxIdx = Math.max(0, rawStart - 10);
  let startOffset = blockText.indexOf(quote, approxIdx);
  if (startOffset < 0) startOffset = blockText.indexOf(quote);
  if (startOffset < 0) startOffset = 0;
  const endOffset = startOffset + quote.length;

  const prefix = blockText.slice(Math.max(0, startOffset - CONTEXT_LEN), startOffset);
  const suffix = blockText.slice(endOffset, Math.min(blockText.length, endOffset + CONTEXT_LEN));

  void rawEnd; // currently unused; kept for future highlight rendering
  const section = computeSectionContext(root, blockEl);
  return {
    block_id: blockId,
    quote,
    prefix,
    suffix,
    start_offset: startOffset,
    end_offset: endOffset,
    heading_path: section.headingPath,
    section_index: section.sectionIndex,
    section_index_path: section.sectionIndexPath,
  };
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
  // throw off the stack, so scope to direct children.
  const blocks = Array.from(root.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-block'),
  );
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
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && n.dataset.block) return n;
    n = n.parentNode;
  }
  return null;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}
