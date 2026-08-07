import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PAGED_CLASS } from '../../lib/paged-reading.js';
import { computeFloatingCardPosition } from './floatingCardPosition.js';

/** Fallback offset below the visible top edge for cards with no anchor. */
const ORPHAN_VIEW_OFFSET_PX = 16;
/** Quiet time after the last scroll event before re-checking placement. */
const SCROLL_SETTLE_MS = 160;

export interface FloatingCardPlacementOptions {
  /** The measured card. Placement waits for it. */
  cardEl: HTMLElement | null;
  /** Positioning host the returned offsets are relative to. */
  hostRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  docElementRef: RefObject<HTMLElement | null>;
  /** The element the card hangs off, re-resolved on every pass. */
  resolveAnchorEl: () => HTMLElement | null;
  /**
   * Identity of what is being placed. A change drops the measured
   * position, so a different card never renders for one frame at the
   * previous card's coordinates.
   */
  resetKey: unknown;
  /**
   * Values that must force a fresh pass even though nothing observable
   * changed size — a swapped document, a refreshed thread list.
   * Length must be stable across renders.
   */
  repositionKeys?: readonly unknown[];
}

/**
 * Place a popover card against an anchor inside the document, in host
 * space: pixels relative to the positioning host that fills the document
 * row, so a card at these offsets scrolls with the text for free.
 *
 * Returns null until the card has been measured; render it hidden until
 * then, or it flashes at the top-left corner first.
 *
 * Shared by the floating-mode thread popover and the new-comment
 * composer, which is the one surface both display modes put over the
 * document.
 */
export function useFloatingCardPlacement({
  cardEl,
  hostRef,
  scrollContainerRef,
  docElementRef,
  resolveAnchorEl,
  resetKey,
  repositionKeys = [],
}: FloatingCardPlacementOptions): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /** Latest placement pass, callable from observers/listeners. */
  const computeRef = useRef<(() => void) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the identity of what is being placed; the effect only clears state.
  useLayoutEffect(() => {
    setPos(null);
  }, [resetKey]);

  // Measure the anchor and the card, then compute a clamped
  // below/above position. A passive effect on purpose — RenderedDoc
  // applies a new docHtml via passive effects earlier in tree order, so
  // by the time this runs the swapped DOM is measurable. Re-fires on
  // card resizes (reply composer opening, "Show more"), host resizes
  // (pane drags, doc reflow), window resizes, and any doc mutation
  // (highlight repaints, mermaid/image late layout).
  // biome-ignore lint/correctness/useExhaustiveDependencies: repositionKeys are explicit re-position triggers for anchor movement after re-renders; its length is fixed per call site.
  useEffect(() => {
    if (!cardEl) return;

    const compute = () => {
      const host = hostRef.current;
      const scroll = scrollContainerRef.current;
      if (!host || !scroll) return;
      const hostRect = host.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      if (hostRect.width <= 0 || cardRect.width <= 0) return;
      const viewTop = scrollRect.top - hostRect.top;

      const anchorEl = resolveAnchorEl();
      let next: { top: number; left: number };
      if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        // Paged mode: the card hangs over a still scrollport, so nothing
        // carries it away when the reader turns past its anchor. Drop the
        // position — a null one renders hidden — and let the page that
        // owns the anchor bring it back.
        if (
          scroll.classList.contains(PAGED_CLASS) &&
          (anchorRect.left < scrollRect.left - 1 || anchorRect.left >= scrollRect.right)
        ) {
          setPos(null);
          return;
        }
        const placed = computeFloatingCardPosition({
          anchorTop: anchorRect.top - hostRect.top,
          anchorBottom: anchorRect.bottom - hostRect.top,
          anchorLeft: anchorRect.left - hostRect.left,
          hostWidth: hostRect.width,
          cardWidth: cardRect.width,
          cardHeight: cardRect.height,
          viewTop,
          viewHeight: scroll.clientHeight,
        });
        next = { top: placed.top, left: placed.left };
      } else {
        // No anchor to hang off (orphaned thread): pin near the top of
        // the current view, centered.
        next = {
          top: Math.max(viewTop + ORPHAN_VIEW_OFFSET_PX, 0),
          left: Math.max((hostRect.width - cardRect.width) / 2, 0),
        };
      }

      setPos((prev) =>
        prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5
          ? prev
          : next,
      );
    };

    computeRef.current = compute;
    compute();

    const onResize = () => compute();
    window.addEventListener('resize', onResize);

    const observers: (ResizeObserver | MutationObserver)[] = [];
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => compute());
      ro.observe(cardEl);
      if (hostRef.current) ro.observe(hostRef.current);
      observers.push(ro);
    }
    // Coalesce doc-mutation bursts (highlight repaints, mermaid text→SVG
    // swaps, image loads) into one re-placement per frame — same pattern
    // as the column layer's remeasure observer.
    const doc = docElementRef.current;
    let raf = 0;
    if (doc && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          compute();
        });
      });
      mo.observe(doc, { childList: true, subtree: true, characterData: true });
      observers.push(mo);
    }

    return () => {
      if (computeRef.current === compute) computeRef.current = null;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const o of observers) o.disconnect();
    };
  }, [
    cardEl,
    resolveAnchorEl,
    hostRef,
    scrollContainerRef,
    docElementRef,
    resetKey,
    ...repositionKeys,
  ]);

  // Placement decides below/above against the viewport at open time, so
  // a navigation that then smooth-scrolls to the anchor can leave the
  // card outside the view. Once scrolling settles, re-place — but only
  // when the card actually ended up off-screen, so ordinary reading
  // never nudges an on-screen card.
  useEffect(() => {
    if (!cardEl) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Every page turn changes whether the anchor is still on screen,
        // so paged mode re-places unconditionally rather than waiting
        // for the card itself to leave the view — it never does, being
        // pinned over the scrollport.
        if (scroll.classList.contains(PAGED_CLASS)) {
          computeRef.current?.();
          return;
        }
        const scrollRect = scroll.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        const outOfView = cardRect.bottom < scrollRect.top || cardRect.top > scrollRect.bottom;
        if (outOfView) computeRef.current?.();
      }, SCROLL_SETTLE_MS);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [cardEl, scrollContainerRef]);

  return pos;
}
