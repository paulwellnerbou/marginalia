import type { TocNode } from './api.js';
import type { SectionAnchorRef } from './section-filter.js';

/**
 * Chapter reading: one chapter of the document on screen at a time, read
 * by scrolling, with the rest of the book out of the layout.
 *
 * The other chapters stay in the DOM and are hidden in place rather than
 * left unrendered. Block ranges, highlights, search, bookmarks and the
 * comment surfaces all walk the live article, and a document that only
 * held one chapter would have each of them see a different book.
 */

/** Set on every element outside the chapter on screen. */
export const CHAPTER_HIDDEN_ATTR = 'data-chapter-hidden';

/**
 * Dispatched (bubbling) from an element some navigation wants to show
 * while its chapter is hidden. The chapter view listens on the article
 * and swaps chapters synchronously, so the caller can measure straight
 * afterwards.
 */
export const REVEAL_CHAPTER_EVENT = 'marginalia:reveal-chapter';

/**
 * The headings a reader thinks of as chapters, by the convention chapter
 * exports and the stats dialog already follow: a lone `# Book title` over
 * `## Chapter` headings is unwrapped so the chapters are its children,
 * unless frontmatter already names the book. Otherwise the top-level
 * headings are the chapters. Text before the first of them belongs to
 * the first chapter.
 */
export function chapterNodes(
  toc: readonly TocNode[],
  frontmatter: Record<string, unknown> | undefined,
): readonly TocNode[] {
  const first = toc[0];
  const titled = frontmatter !== undefined && 'title' in frontmatter;
  if (toc.length === 1 && first && first.level === 1 && first.children.length > 0 && !titled) {
    return first.children;
  }
  return toc;
}

/**
 * Index of the chapter `node` reads in: the last chapter heading at or
 * before it in document order. Anything ahead of the first heading is
 * preamble and counts as the first chapter.
 */
export function chapterIndexOf(headings: readonly Element[], node: Node): number {
  let index = 0;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i] as Element;
    const reached =
      heading === node ||
      heading.contains(node) ||
      (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (!reached) break;
    index = i;
  }
  return index;
}

/** True when `el` opens with `target`: a section container whose first child is the heading. */
function leadsWith(el: Element, target: Element): boolean {
  for (let child = el.firstElementChild; child; child = child.firstElementChild) {
    if (child === target) return true;
  }
  return false;
}

/**
 * Hide every element under `parent` that lies wholly outside `[start, end)`.
 * An element straddling a boundary is descended into rather than hidden,
 * which is what lets one walk serve Markdown's flat headings, the fold
 * wrappers nesting sections inside each other, and AsciiDoc's section
 * containers alike.
 */
function hideOutside(parent: Element, start: Element | null, end: Element | null): void {
  for (const child of Array.from(parent.children)) {
    if (start && child !== start && child.contains(start)) {
      hideOutside(child, start, end);
    } else if (end && (child === end || leadsWith(child, end))) {
      child.setAttribute(CHAPTER_HIDDEN_ATTR, '');
    } else if (end && child.contains(end)) {
      hideOutside(child, start, end);
    } else if (
      (start && (start.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) ||
      (end && (end.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    ) {
      child.setAttribute(CHAPTER_HIDDEN_ATTR, '');
    }
  }
}

export function clearChapterView(article: Element): void {
  for (const el of Array.from(article.querySelectorAll(`[${CHAPTER_HIDDEN_ATTR}]`))) {
    el.removeAttribute(CHAPTER_HIDDEN_ATTR);
  }
}

/** Show chapter `index` of `headings` and hide the rest. Fewer than two chapters shows everything. */
export function showChapter(article: Element, headings: readonly Element[], index: number): void {
  clearChapterView(article);
  if (headings.length < 2) return;
  const clamped = Math.min(Math.max(index, 0), headings.length - 1);
  // The first chapter starts at the top of the article, preamble and all.
  const start = clamped > 0 ? (headings[clamped] ?? null) : null;
  const end = headings[clamped + 1] ?? null;
  hideOutside(article, start, end);
}

/**
 * Bring `el`'s chapter on screen if chapter reading has it hidden. Every
 * reveal path calls this before measuring — a hidden element has no box,
 * so it would scroll nowhere.
 */
export function revealChapterOf(el: Element): void {
  if (!el.closest(`[${CHAPTER_HIDDEN_ATTR}]`)) return;
  el.dispatchEvent(new CustomEvent(REVEAL_CHAPTER_EVENT, { bubbles: true }));
}

/**
 * Chapter each block reads in, from the heading chain
 * `collectBlockSectionIds` maps it to. A chain naming no chapter is
 * preamble, which belongs to the first one.
 */
export function chapterOfSectionChain(
  chain: readonly string[],
  chapterIndexById: ReadonlyMap<string, number>,
): number {
  for (const id of chain) {
    const index = chapterIndexById.get(id);
    if (index !== undefined) return index;
  }
  return 0;
}

/**
 * Whether a comment anchor sits in chapter `index`, so its card belongs on
 * screen. Spans count from either end. An anchor whose blocks the document
 * no longer has is placed by nothing, and stays wherever it is shown.
 */
export function anchorInChapter(
  anchor: SectionAnchorRef,
  blockSections: ReadonlyMap<string, readonly string[]>,
  chapterIndexById: ReadonlyMap<string, number>,
  index: number,
): boolean {
  const chapterOf = (blockId: string | null | undefined): number | null => {
    const chain = blockId ? blockSections.get(blockId) : undefined;
    return chain === undefined ? null : chapterOfSectionChain(chain, chapterIndexById);
  };
  const start = chapterOf(anchor.block_id);
  const end = chapterOf(anchor.end_block_id);
  if (start === null && end === null) return true;
  return start === index || end === index;
}
