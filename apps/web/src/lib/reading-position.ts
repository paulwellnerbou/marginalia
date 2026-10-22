/**
 * Where the reader left each document, so coming back to its tab — or
 * opening it again next week — picks up there instead of at the top.
 *
 * Held as a place in the text, never as a scroll offset: the document
 * can come back paged instead of scrolled, at another reading width,
 * with the comment column open, or with a paragraph added above, and
 * only the words themselves survive all of that.
 */

const KEY = 'marginalia.readingPositions';
/** Documents remembered; the one read longest ago gives way. */
const MAX = 50;

export interface ReadingPosition {
  /** `data-block` id of the block the reader was in. */
  block: string;
  /** Which copy of it, where identical blocks repeat — ids are content hashes. */
  copy: number;
  /** Its index among all blocks, for when an edit has rehashed it. */
  ordinal: number;
  /** Characters into the block's text. */
  offset: number;
  /** Distance from the top of the scrollport to that text, in px. */
  top: number;
}

interface Stored extends ReadingPosition {
  uid: string;
}

function loadAll(): Stored[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStored) : [];
  } catch {
    return [];
  }
}

function saveAll(list: Stored[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded — best-effort */
  }
}

export function loadReadingPosition(uid: string): ReadingPosition | null {
  const found = loadAll().find((p) => p.uid === uid);
  if (!found) return null;
  const { uid: _, ...position } = found;
  return position;
}

/** Most recently saved last, so trimming from the front drops the stalest. */
export function saveReadingPosition(uid: string, position: ReadingPosition): void {
  const rest = loadAll().filter((p) => p.uid !== uid);
  saveAll([...rest, { uid, ...position }].slice(-MAX));
}

export function forgetReadingPosition(uid: string): void {
  const list = loadAll();
  const rest = list.filter((p) => p.uid !== uid);
  if (rest.length !== list.length) saveAll(rest);
}

function isStored(v: unknown): v is Stored {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.uid === 'string' &&
    typeof p.block === 'string' &&
    ['copy', 'ordinal', 'offset', 'top'].every((k) => Number.isFinite(p[k]))
  );
}

/**
 * A position in the live DOM. Nothing about the *layout* survives a
 * reflow usefully. A page number is meaningless once the count changes.
 * So is which column fragment of a block the reader was on, since wider
 * pages hold more text and the same fragment index lands somewhere else
 * entirely — that is a page number wearing a different hat. And a block
 * alone is too coarse: `getBoundingClientRect()` reports the union of a
 * block's fragments, whose left edge names the first page it appears on
 * however far into a long paragraph the reader actually is. Only the
 * text itself holds still, so that is what gets remembered.
 */
export interface TextPlace {
  node: Node;
  offset: number;
}

/** Text position under a viewport point, across both spellings of the API. */
function caretAt(x: number, y: number): TextPlace | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function nodeLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : node.childNodes.length;
}

function blockOf(node: Node): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest<HTMLElement>('[data-block]') ?? null;
}

/** The text the screen opens with, or null where it can't be read. */
export function textPlaceAtTop(scroll: HTMLElement): TextPlace | null {
  const box = scroll.getBoundingClientRect();
  // Down the middle of the reading column. The scrollport's own middle
  // can be the comment column's gutter; a paged article spans every page,
  // so clipping it to the scrollport leaves the page in front.
  const article = scroll.querySelector('article.marginalia')?.getBoundingClientRect();
  const left = Math.max(box.left, article?.left ?? box.left);
  const right = Math.min(box.right, article?.right ?? box.right);
  const x = right > left ? (left + right) / 2 : box.left + box.width / 2;
  // From the first line inwards: the top of a page can be page margin,
  // the clearance above a heading, or the tail of a floated figure, none
  // of which sit on any text.
  for (const fraction of [0.04, 0.12, 0.25, 0.45, 0.7]) {
    const place = caretAt(x, box.top + box.height * fraction);
    // Overlays share the viewport with the scrollport — the floating
    // comment toolbar sits over the top of every page — so only a hit
    // inside the document itself counts.
    if (place && blockOf(place.node) && scroll.contains(place.node)) return place;
  }
  return null;
}

/**
 * One character of `place`, where it is laid out. A collapsed range can
 * report an empty rect at a line boundary, which locates nothing.
 */
export function rectOfTextPlace(place: TextPlace): DOMRect | null {
  if (!place.node.isConnected) return null;
  const length = nodeLength(place.node);
  const start = Math.min(place.offset, length);
  const range = document.createRange();
  try {
    range.setStart(place.node, start);
    range.setEnd(place.node, Math.min(start + 1, length));
  } catch {
    return null;
  }
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.left === 0) return null;
  return rect;
}

/** Where the reader is in `root`, ready to store. */
export function readingPositionOf(scroll: HTMLElement, root: HTMLElement): ReadingPosition | null {
  const place = textPlaceAtTop(scroll);
  const block = place && blockOf(place.node);
  const rect = place && rectOfTextPlace(place);
  if (!place || !block || !rect) return null;
  const id = block.dataset.block ?? '';
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-block]'));
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(place.node, place.offset);
  return {
    block: id,
    copy: blocks.filter((b) => b.dataset.block === id).indexOf(block),
    ordinal: blocks.indexOf(block),
    offset: before.toString().length,
    top: Math.round(rect.top - scroll.getBoundingClientRect().top),
  };
}

/**
 * The stored position back in `root`, as one character's range: the
 * block it names if that still exists, else whatever block now holds its
 * ordinal, from the start.
 */
export function resolveReadingPosition(root: HTMLElement, position: ReadingPosition): Range | null {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-block]'));
  const copies = blocks.filter((b) => b.dataset.block === position.block);
  const same = copies[position.copy] ?? copies[0];
  const block = same ?? blocks[Math.min(position.ordinal, blocks.length - 1)];
  if (!block) return null;
  const range = document.createRange();
  if (same) {
    // Counted over every text node, as `Range.toString()` counted them.
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = position.offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = (node as Text).data.length;
      if (remaining < length) {
        range.setStart(node, remaining);
        range.setEnd(node, remaining + 1);
        return range;
      }
      remaining -= length;
    }
  }
  range.selectNode(block);
  return range;
}
