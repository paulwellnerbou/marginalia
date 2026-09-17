/**
 * Where the reader's bookmarks sit in the rendered document, and the small
 * ribbon each bookmarked block carries.
 *
 * The ribbon is a real element rather than a `::before`/`::after`: themes
 * already spend those on blocks (beautiful.css draws a blockquote's opening
 * quote with one), and marking a block must not take its decoration away.
 * It holds no text node — only an SVG path — so nothing that reads block
 * text (anchoring, search, read-aloud) sees it, and it stays out of
 * `INJECTED_CHROME_CLASSES`, whose fast path relies on chrome living under
 * headings alone.
 */

import { type AnchorSection, resolveAnchorElement } from './anchor-target.js';
import { isBookmark, type Thread } from './api.js';
import { closestTopBlock } from './selection.js';

/**
 * An element of its own rather than a classed span: the sanitizer strips
 * unknown tags from documents, so nothing an author writes can be taken for
 * a marker, removed as one, or styled as one.
 */
const BOOKMARK_MARKER_TAG = 'marginalia-bookmark';

/** Set on a block carrying a marker, so the stylesheet can position it. */
const BOOKMARKED_ATTR = 'data-bookmarked';

export interface BookmarkMarkerSpec {
  threadId: string;
  blockId: string;
  quote: string | null;
  section: AnchorSection;
}

/**
 * The bookmarks among `threads` that have a place to be drawn. An orphaned
 * one lost its passage in an edit; it stays listed in the Bookmarks tab but
 * marks nothing.
 */
export function bookmarkMarkerSpecs(threads: readonly Thread[]): BookmarkMarkerSpec[] {
  const specs: BookmarkMarkerSpec[] = [];
  for (const t of threads) {
    if (!isBookmark(t) || t.link_status === 'orphaned' || !t.anchor.block_id) continue;
    specs.push({
      threadId: t.id,
      blockId: t.anchor.block_id,
      quote: t.anchor.quote,
      section: {
        heading_path: t.anchor.heading_path,
        section_index: t.anchor.section_index,
        section_index_path: t.anchor.section_index_path,
      },
    });
  }
  return specs;
}

/**
 * The bookmark that marks `el`, resolved the way its marker is placed —
 * so a block repeated word for word elsewhere does not count as marked
 * because its twin is.
 */
export function bookmarkMarking(
  root: HTMLElement,
  el: HTMLElement,
  bookmarks: readonly BookmarkMarkerSpec[],
): BookmarkMarkerSpec | null {
  // An anchor on a top-level block can resolve onto one of its sub-blocks.
  const ids = new Set([el.dataset.subblock, el.dataset.block, closestTopBlock(el)?.dataset.block]);
  for (const b of bookmarks) {
    if (!ids.has(b.blockId)) continue;
    if (resolveAnchorElement(root, b.blockId, b.quote, b.section) === el) return b;
  }
  return null;
}

// No whitespace between tags: a text node would make the marker part of
// the block's textContent.
const RIBBON_SVG =
  '<svg viewBox="0 0 15 15" aria-hidden="true" focusable="false"><path d="M3.5 1.5h8v12L7.5 10.6 3.5 13.5z"/></svg>';

/**
 * Brings the markers under `root` in line with `bookmarks`, touching only
 * blocks whose state changes. The document is watched by mutation
 * observers that re-lay out comment cards and pages on any child-list
 * change, so an unchanged set must not remove and re-add anything.
 */
export function syncBookmarkMarkers(
  root: HTMLElement,
  bookmarks: readonly BookmarkMarkerSpec[],
): void {
  const wanted = new Set<HTMLElement>();
  for (const b of bookmarks) {
    const el = resolveAnchorElement(root, b.blockId, b.quote, b.section);
    if (el) wanted.add(el);
  }

  const marked = new Set<HTMLElement>();
  for (const marker of Array.from(root.querySelectorAll<HTMLElement>(BOOKMARK_MARKER_TAG))) {
    const host = marker.parentElement;
    if (host && wanted.has(host) && !marked.has(host)) {
      marked.add(host);
      continue;
    }
    marker.remove();
    if (host && !wanted.has(host)) host.removeAttribute(BOOKMARKED_ATTR);
  }

  for (const host of wanted) {
    if (marked.has(host)) continue;
    const marker = document.createElement(BOOKMARK_MARKER_TAG);
    marker.setAttribute('aria-hidden', 'true');
    marker.innerHTML = RIBBON_SVG;
    host.setAttribute(BOOKMARKED_ATTR, 'true');
    host.append(marker);
  }
}
