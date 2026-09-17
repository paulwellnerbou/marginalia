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
 * One highlight object stays registered and has its range swapped.
 * WebKit repaints a registered highlight that is cleared or changed, but
 * not one removed from the registry, even with a new one registered in
 * its place: the sentence before keeps its tint, and after the last one
 * everything read stays marked.
 *
 * Where the API is missing (Safari before 17.2), the enclosing block is
 * tinted instead — coarser, but still mutation-free.
 */

const HIGHLIGHT_NAME = 'marginalia-read-aloud';
const BLOCK_ATTR = 'data-read-aloud-block';

interface HighlightLike {
  add(range: Range): void;
  clear(): void;
}

interface HighlightRegistry {
  get(name: string): HighlightLike | undefined;
  set(name: string, highlight: HighlightLike): void;
}

type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

function registry(): HighlightRegistry | null {
  return (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;
}

function highlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null;
}

/** Tracks the fallback-tinted block so it can be cleaned up later. */
let tintedBlock: HTMLElement | null = null;

let highlight: HighlightLike | null = null;

export function paintSegment(range: Range | null, blockEl: HTMLElement | null): void {
  clearHighlight();

  const highlights = registry();
  const Ctor = highlightCtor();
  if (range && highlights && Ctor) {
    highlight ??= new Ctor();
    if (highlights.get(HIGHLIGHT_NAME) !== highlight) highlights.set(HIGHLIGHT_NAME, highlight);
    highlight.add(range);
    return;
  }

  if (blockEl) {
    blockEl.setAttribute(BLOCK_ATTR, 'true');
    tintedBlock = blockEl;
  }
}

export function clearHighlight(): void {
  highlight?.clear();
  tintedBlock?.removeAttribute(BLOCK_ATTR);
  tintedBlock = null;
}
