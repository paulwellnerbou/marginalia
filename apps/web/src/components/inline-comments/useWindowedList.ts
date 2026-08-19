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

  // Track the scrolling ancestor's position. Reads happen on scroll and on
  // resize; both are passive and rAF-coalesced so a fast scroll does not
  // queue a layout read per event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keys.length is the re-attach trigger — the scrolling ancestor only exists, and only becomes scrollable, once the list has rows.
  useEffect(() => {
    if (!windowed) return;
    const root = rootRef.current;
    const scroller = scrollParentOf(root);
    if (!scroller || !root) return;

    let frame = 0;
    const read = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      const scrollerTop =
        scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      setViewport({
        // Where the viewport starts, in the list's own coordinates.
        top: scrollerTop - rootTop,
        height: scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight,
      });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };

    read();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(scroller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, [windowed, rootRef, keys.length]);

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
