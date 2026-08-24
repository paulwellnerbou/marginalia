import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { windowedRange } from './windowedRange.js';

/**
 * Render only the rows near the viewport, with spacers standing in for the
 * rest.
 *
 * A thread card is a heavy tree — a dozen Radix controls, each with its own
 * context and effects — and a long review can hold well over a thousand of
 * them. React re-runs every one of those on any change to the thread list,
 * which is why accepting a proposal froze the page for seconds: the request
 * came back quickly and then the main thread spent seventeen seconds
 * re-rendering cards nobody could see.
 *
 * Heights are measured as rows render and remembered per key, so a row that
 * has been seen once contributes its real height to the spacers. Rows never
 * seen fall back to `estimateHeight`; the scrollbar is therefore approximate
 * until the reader has been past a region, which is the usual trade and is
 * invisible at this row count.
 */

export interface WindowedList {
  /** First row to render (inclusive). */
  start: number;
  /** Last row to render (exclusive). */
  end: number;
  /** Height of the spacer standing in for rows before `start`. */
  padTop: number;
  /** Height of the spacer standing in for rows after `end`. */
  padBottom: number;
  /** Attach to each rendered row so its height can be recorded. */
  measure: (key: string) => (el: HTMLElement | null) => void;
}

export interface WindowedListOptions {
  /** Keys of every row, in render order. */
  keys: readonly string[];
  /** Assumed height of a row that has not been measured yet. */
  estimateHeight: number;
  /** Element containing the rows; its scrolling ancestor drives the window. */
  rootRef: React.RefObject<HTMLElement | null>;
  /**
   * How far beyond the viewport to keep rendered. Generous on purpose:
   * scrolling should not wait for React, and a card is cheap next to a
   * blank gap.
   */
  overscanPx?: number;
  /**
   * A row that must stay rendered wherever it is — the thread a deep link
   * or a jump just focused. `scrollIntoView` and the flash animation both
   * find it by DOM query, so it has to exist before they run.
   */
  pinnedKey?: string | null;
  /**
   * Below this many rows, render everything. Windowing costs a scroll
   * listener and a measuring pass, which is not worth it for a document
   * with a normal number of comments — and it keeps the common case on
   * exactly the code path it has always been on.
   */
  threshold?: number;
  /**
   * Change this to scroll the list back to the top and recompute the window
   * from there. A filter, sort, or search change remakes the list under a
   * scroll offset earned browsing the old one; left alone, that offset points
   * into rows that are gone, and the window lands the reader in a full-height
   * spacer with nothing rendered until they scroll back up. Reset in the
   * same layout pass so the fresh window paints in place of the stale one.
   */
  resetToken?: unknown;
}

/** Nearest ancestor that actually scrolls, or the document scroller. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement as HTMLElement | null;
}

export function useWindowedList({
  keys,
  estimateHeight,
  rootRef,
  overscanPx = 900,
  pinnedKey = null,
  threshold = 60,
  resetToken,
}: WindowedListOptions): WindowedList {
  const heights = useRef(new Map<string, number>());
  const [, bumpMeasured] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const windowed = keys.length > threshold;

  // Coalesce measurements taken during one commit into a single re-render;
  // without it, a screenful of rows reporting their heights would each
  // schedule their own pass.
  const measurePending = useRef(false);
  const noteHeight = useCallback((key: string, height: number) => {
    if (height <= 0) return;
    const prev = heights.current.get(key);
    // Sub-pixel churn from zoom or font loading is not worth a re-layout.
    if (prev !== undefined && Math.abs(prev - height) < 1) return;
    heights.current.set(key, height);
    if (measurePending.current) return;
    measurePending.current = true;
    queueMicrotask(() => {
      measurePending.current = false;
      bumpMeasured((n) => n + 1);
    });
  }, []);

  const measure = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) noteHeight(key, el.offsetHeight);
    },
    [noteHeight],
  );

  /*
   * Track the scrolling ancestor's position.
   *
   * Deliberately not coalesced through `requestAnimationFrame`. rAF is
   * throttled or stopped outright whenever the page is not being painted
   * — a background tab, an occluded window, a machine saving power — and
   * a scroll handler that never runs leaves the list showing whichever
   * rows it happened to have when the throttling began. The work here is
   * one cheap property read, so it can simply run on the event.
   *
   * The list's offset inside the scroller is measured separately, on
   * mount and on resize, so scrolling itself reads `scrollTop` alone and
   * never forces layout.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: keys.length is the re-attach trigger — the scrolling ancestor only exists, and only becomes scrollable, once the list has rows.
  useEffect(() => {
    if (!windowed) return;
    const root = rootRef.current;
    const scroller = scrollParentOf(root);
    if (!scroller || !root) return;
    const isPageScroller = scroller === document.scrollingElement;

    // Distance from the top of the scroller's content to the top of the
    // list. Constant while the list sits where it is, so it is measured
    // rather than recomputed per scroll event.
    let listOffset = 0;
    const measureOffset = () => {
      const rootTop = root.getBoundingClientRect().top;
      const scrollerTop = isPageScroller ? 0 : scroller.getBoundingClientRect().top;
      listOffset = rootTop - scrollerTop + scroller.scrollTop;
    };

    let lastTop = Number.NaN;
    let lastHeight = Number.NaN;
    const read = () => {
      const top = scroller.scrollTop - listOffset;
      const height = isPageScroller ? window.innerHeight : scroller.clientHeight;
      // A few pixels of scroll cannot change which rows are rendered, and
      // re-rendering on every one of them would be the cost this hook
      // exists to avoid.
      if (Math.abs(top - lastTop) < 8 && height === lastHeight) return;
      lastTop = top;
      lastHeight = height;
      setViewport({ top, height });
    };
    const onResize = () => {
      measureOffset();
      lastTop = Number.NaN;
      read();
    };

    measureOffset();
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(scroller);
    ro.observe(root);
    return () => {
      scroller.removeEventListener('scroll', read);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
    };
  }, [windowed, rootRef, keys.length]);

  /*
   * Scroll to the top when the caller remakes the list.
   *
   * Runs in the layout pass, not off the scroll event that setting
   * `scrollTop` fires: a programmatic scroll dispatches its `scroll`
   * asynchronously, so leaning on it would paint the stale window for a
   * frame first. Setting `viewport.top` here recomputes the range before
   * paint, and the scroll event that follows only confirms it.
   */
  const lastReset = useRef(resetToken);
  useIsomorphicLayoutEffect(() => {
    if (lastReset.current === resetToken) return; // first render, or no reset asked
    lastReset.current = resetToken;
    const scroller = scrollParentOf(rootRef.current);
    // Guard the write: refining a search bumps the token on every keystroke,
    // and assigning scrollTop it already holds still queues a scroll event.
    if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    setViewport((v) => (v.top === 0 ? v : { ...v, top: 0 }));
  }, [resetToken, rootRef]);

  return useMemo<WindowedList>(() => {
    if (!windowed) {
      return { start: 0, end: keys.length, padTop: 0, padBottom: 0, measure };
    }
    const range = windowedRange({
      keys,
      heights: heights.current,
      estimateHeight,
      viewportTop: viewport.top,
      viewportHeight: viewport.height,
      overscanPx,
      pinnedKey,
    });
    return { ...range, measure };
    // `heights.current` is a ref; `bumpMeasured` is what re-runs this after
    // a measuring pass, so it is deliberately not a dependency.
  }, [windowed, keys, estimateHeight, viewport, overscanPx, pinnedKey, measure]);
}

/** Re-export for tests that need the same fallback the hook uses. */
export const DEFAULT_ROW_ESTIMATE = 160;

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server. Kept here so
 * the hook file owns its own SSR guard rather than importing one.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;
