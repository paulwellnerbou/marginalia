/**
 * Paints the sentence currently being spoken.
 *
 * Uses the CSS Custom Highlight API rather than wrapping the text in
 * `<mark>`. The article already carries two mark-based highlight layers
 * (comments and document search), and each of them clears its marks by
 * unwrapping and re-normalizing text nodes. A third layer re-wrapping a
 * new sentence every few seconds would corrupt both. `CSS.highlights`
 * paints from a `Range` and mutates nothing, so the layers cannot
 * interfere with each other at all.
 *
 * Where the API is missing (Safari before 17.2), the enclosing block is
 * tinted instead — coarser, but still mutation-free.
 */

const HIGHLIGHT_NAME = 'marginalia-read-aloud';
const BLOCK_ATTR = 'data-read-aloud-block';

interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}

type HighlightCtor = new (...ranges: Range[]) => object;

function registry(): HighlightRegistry | null {
  return (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;
}

function highlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null;
}

/** Tracks the fallback-tinted block so it can be cleaned up later. */
let tintedBlock: HTMLElement | null = null;

export function paintSegment(range: Range | null, blockEl: HTMLElement | null): void {
  clearHighlight();

  const highlights = registry();
  const Ctor = highlightCtor();
  if (range && highlights && Ctor) {
    highlights.set(HIGHLIGHT_NAME, new Ctor(range));
    return;
  }

  if (blockEl) {
    blockEl.setAttribute(BLOCK_ATTR, 'true');
    tintedBlock = blockEl;
  }
}

export function clearHighlight(): void {
  registry()?.delete(HIGHLIGHT_NAME);
  tintedBlock?.removeAttribute(BLOCK_ATTR);
  tintedBlock = null;
}
