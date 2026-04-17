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
  return {
    block_id: blockId,
    quote,
    prefix,
    suffix,
    start_offset: startOffset,
    end_offset: endOffset,
  };
}

export function selectionRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
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
