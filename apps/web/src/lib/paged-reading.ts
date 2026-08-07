/**
 * Geometry for paged (e-reader) reading mode.
 *
 * The document is laid out as CSS multi-column boxes inside `.doc-scroll`:
 * one column per page, each exactly as wide as the scrollport, overflowing
 * horizontally. So a "page turn" is a horizontal scroll by one pitch, and
 * "which page is this element on" is a division.
 *
 * Column boxes are not elements, so none of this can be expressed with
 * scroll-snap targets — the pitch has to be computed and scrolled to.
 * app.css keeps the CSS side of that contract: in paged mode
 * `.doc-scroll` carries no horizontal padding, and the columns are one
 * per page at `100cqw` with no gap, which makes the pitch exactly
 * `clientWidth`. A column gap would not survive that arithmetic — see
 * the note on `.doc-paged .doc-body`.
 */

/** Applied to `.doc-scroll` while paged reading is on. */
export const PAGED_CLASS = 'doc-paged';

/** Sub-pixel slack so a scrollWidth landing a hair under N pitches still counts as N pages. */
const PAGE_EPSILON_PX = 1;

export interface PageMetrics {
  /** Distance between the left edges of consecutive pages, in px. */
  pitch: number;
  /** Total pages the document currently fragments into (>= 1). */
  pageCount: number;
  /** 0-based index of the page filling the scrollport. */
  currentPage: number;
}

/** Clamp a page index into `[0, pageCount)`. */
export function clampPage(index: number, pageCount: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.round(index), 0), Math.max(pageCount - 1, 0));
}

/**
 * Pages a document of `scrollWidth` fragments into. The final column
 * carries no trailing gap, so the total falls just short of a whole
 * multiple of the pitch — hence the epsilon before rounding up.
 */
export function pageCountOf(scrollWidth: number, pitch: number): number {
  if (pitch <= 0) return 1;
  return Math.max(1, Math.ceil((scrollWidth - PAGE_EPSILON_PX) / pitch));
}

/** Page index a scroll offset is resting on. */
export function pageIndexAt(scrollLeft: number, pitch: number): number {
  if (pitch <= 0) return 0;
  return Math.max(0, Math.round(scrollLeft / pitch));
}

/**
 * Page index holding content at `offsetLeft` (a document-space x, i.e.
 * measured from the start of the first page). Floor, not round: the
 * reading column is centred inside its page, so content sits at
 * `page * pitch + margin` and must not round up into the next page.
 */
export function pageIndexOfOffset(offsetLeft: number, pitch: number): number {
  if (pitch <= 0) return 0;
  return Math.max(0, Math.floor(offsetLeft / pitch));
}

/** The paged scroll container `el` reads inside, if any. */
export function pagedScrollerOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(`.doc-scroll.${PAGED_CLASS}`);
}

export function measurePages(scroll: HTMLElement): PageMetrics {
  const pitch = scroll.clientWidth;
  const pageCount = pageCountOf(scroll.scrollWidth, pitch);
  return {
    pitch,
    pageCount,
    currentPage: clampPage(pageIndexAt(scroll.scrollLeft, pitch), pageCount),
  };
}

/**
 * Page holding a live viewport rect. Reach for this over
 * `pageIndexOfElement` whenever the thing being located can fragment: a
 * paragraph spanning pages reports the *union* of its fragments, whose
 * left edge always names the first page it appears on, however far into
 * it you actually are. A single rect from `getClientRects()` is one
 * page's worth.
 */
export function pageIndexOfClientRect(scroll: HTMLElement, rect: { left: number }): number | null {
  const pitch = scroll.clientWidth;
  if (pitch <= 0) return null;
  const offsetLeft = rect.left - scroll.getBoundingClientRect().left + scroll.scrollLeft;
  return clampPage(pageIndexOfOffset(offsetLeft, pitch), pageCountOf(scroll.scrollWidth, pitch));
}

/** Which page `el` starts on, or null when it can't be measured. */
export function pageIndexOfElement(scroll: HTMLElement, el: Element): number | null {
  if (!el.isConnected) return null;
  return pageIndexOfClientRect(scroll, el.getBoundingClientRect());
}

export function goToPage(
  scroll: HTMLElement,
  index: number,
  behavior: ScrollBehavior = 'smooth',
): void {
  const { pitch, pageCount } = measurePages(scroll);
  scroll.scrollTo({ left: clampPage(index, pageCount) * pitch, behavior });
}

/**
 * Bring `el` into view for whichever mode the reader is in: snap to its
 * page when paged, otherwise the caller's own `scrollIntoView`. Every
 * reveal path — TOC, search, hash links, read-aloud, comment anchors —
 * goes through here so none of them can strand the reader mid-page.
 */
export function revealElement(el: Element, options: ScrollIntoViewOptions): void {
  const scroll = pagedScrollerOf(el);
  if (!scroll) {
    el.scrollIntoView(options);
    return;
  }
  const page = pageIndexOfElement(scroll, el);
  if (page === null) return;
  goToPage(scroll, page, options.behavior === 'auto' ? 'auto' : 'smooth');
}
