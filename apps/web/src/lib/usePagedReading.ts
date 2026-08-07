import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { clampPage, goToPage, measurePages } from './paged-reading.js';

/** Horizontal travel that counts as a page-turning swipe, in px. */
const SWIPE_MIN_PX = 48;
/** How much a swipe must favour the horizontal to not be a scroll attempt. */
const SWIPE_AXIS_RATIO = 1.5;
/** Longest a gesture may take and still read as a swipe (ms). */
const SWIPE_MAX_MS = 800;
/** Quiet period after a wheel-driven turn, so one flick turns one page (ms). */
const WHEEL_COOLDOWN_MS = 350;
/** Wheel delta that adds up to a page turn. */
const WHEEL_MIN_DELTA = 24;
/** Debounce on reflow-triggered re-measurement (ms). */
const REMEASURE_DEBOUNCE_MS = 120;
/**
 * How long after a swipe a tap on an edge zone is treated as that same
 * gesture's tail. A swipe that starts and ends inside one zone would
 * otherwise fire the swipe *and* the zone's click, turning two pages.
 */
const TAP_AFTER_SWIPE_MS = 400;

export interface PagedReading {
  /** 0-based index of the page on screen. */
  page: number;
  pageCount: number;
  goTo: (index: number, behavior?: ScrollBehavior) => void;
  turn: (delta: number) => void;
  /** Turn from a tap on an edge zone, unless a swipe just handled it. */
  tap: (delta: number) => void;
}

/**
 * Where wheel and swipe gestures are listened for: the viewport around
 * the scrollport, not the scrollport itself. The edge tap zones are
 * *siblings* of `.doc-scroll`, so a swipe begun in the outer margin —
 * exactly where a thumb rests on a tablet — would otherwise land on a
 * zone and never reach a listener.
 */
function gestureSurfaceOf(scroll: HTMLElement | null): HTMLElement | null {
  return scroll?.closest<HTMLElement>('.doc-viewport') ?? scroll;
}

/**
 * Widgets that steer themselves with the arrow keys. The reading-width
 * and text-size sliders and the layout toggle all sit a tab-stop away
 * from the document, and a page turn on every arrow press would leave
 * them keyboard-inoperable.
 */
const ARROW_KEY_WIDGETS =
  '[role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"],' +
  '[role="menubar"], [role="tablist"], [role="tab"], [role="radiogroup"], [role="radio"],' +
  '[role="textbox"], [role="grid"], [role="tree"]';

/** True while the event target is somewhere the keys already mean something. */
function keysBelongToWidget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest(ARROW_KEY_WIDGETS) !== null;
}

/**
 * Drives paged mode: tracks which page is showing, keeps the reader on
 * their place across reflow, and turns pages from keyboard, wheel and
 * swipe. Inert unless `enabled`.
 */
export function usePagedReading(
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** Changes whenever the rendered document or the panes around it move. */
  remeasureKey: unknown,
): PagedReading {
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const syncFromScroller = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const metrics = measurePages(scroll);
    setPageCount(metrics.pageCount);
    setPage(metrics.currentPage);
  }, [scrollRef]);

  const goTo = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const { pageCount: total } = measurePages(scroll);
      const next = clampPage(index, total);
      goToPage(scroll, next, behavior);
      // Optimistic: a programmatic scroll's own event is the only other
      // thing that would move the indicator, and it can be throttled or
      // (in embedded browsers) never delivered at all.
      setPageCount(total);
      setPage(next);
    },
    [scrollRef],
  );

  const pageRef = useRef(page);
  pageRef.current = page;
  const turn = useCallback((delta: number) => goTo(pageRef.current + delta), [goTo]);

  const lastSwipeAt = useRef(0);
  const tap = useCallback(
    (delta: number) => {
      if (performance.now() - lastSwipeAt.current < TAP_AFTER_SWIPE_MS) return;
      turn(delta);
    },
    [turn],
  );

  /**
   * Publish the page box in px for the CSS that can't derive it: the
   * height clamps oversized media, the gutter sizes the edge tap zones.
   * Both have to be measured — `100%` of an auto-height ancestor is
   * meaningless, and the reading width is authored in `ch`, which would
   * resolve against the wrong font anywhere outside the article.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasureKey is a pure trigger — reading width, zoom, theme and pane widths all move the page box.
  useEffect(() => {
    const scroll = scrollRef.current;
    const viewport = gestureSurfaceOf(scroll);
    if (!scroll || !viewport) return;
    if (!enabled) {
      scroll.style.removeProperty('--doc-page-height');
      viewport.style.removeProperty('--doc-page-gutter');
      scroll.scrollLeft = 0;
      setPage(0);
      setPageCount(1);
      return;
    }
    const publish = () => {
      // The column box's own height: the page margins are padding on
      // `.doc-body` and they aren't symmetric, and `clientHeight`
      // measures the padding box, so both have to come off.
      const column = scroll.querySelector<HTMLElement>('.doc-body');
      if (column) {
        const style = window.getComputedStyle(column);
        const height =
          column.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        scroll.style.setProperty('--doc-page-height', `${Math.max(0, Math.round(height))}px`);
      } else {
        scroll.style.setProperty('--doc-page-height', `${scroll.clientHeight}px`);
      }

      // The article spans every page, so its bounding rect is the union
      // of all of them; one client rect is one page's worth of it.
      const article = scroll.querySelector<HTMLElement>('article.marginalia');
      const fragment = article?.getClientRects()[0];
      const gutter = fragment ? (scroll.clientWidth - fragment.width) / 2 : 0;
      viewport.style.setProperty('--doc-page-gutter', `${Math.max(0, Math.round(gutter))}px`);
    };
    publish();
    window.addEventListener('resize', publish);
    return () => {
      window.removeEventListener('resize', publish);
      scroll.style.removeProperty('--doc-page-height');
      viewport.style.removeProperty('--doc-page-gutter');
    };
  }, [enabled, scrollRef, remeasureKey]);

  /**
   * Re-measure after anything that repaginates — a pane drag, a font or
   * mermaid render, a collapsed section. Re-aligning to the same page
   * *number* would drift the reader, since the count changed underneath
   * them; hold the block they were looking at instead.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasureKey is a pure trigger — the effect re-measures the DOM rather than reading it.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;

    let timer = 0;
    const remeasure = () => {
      const scrollRect = scroll.getBoundingClientRect();
      // The first block still starting at or after the left edge is what
      // the reader has in front of them.
      let held: Element | null = null;
      for (const block of scroll.querySelectorAll('[data-block]')) {
        if (block.getBoundingClientRect().left >= scrollRect.left - 1) {
          held = block;
          break;
        }
      }
      const metrics = measurePages(scroll);
      setPageCount(metrics.pageCount);
      if (!held) {
        setPage(metrics.currentPage);
        return;
      }
      const offsetLeft = held.getBoundingClientRect().left - scrollRect.left + scroll.scrollLeft;
      const target = clampPage(Math.floor(offsetLeft / metrics.pitch), metrics.pageCount);
      goToPage(scroll, target, 'auto');
      setPage(target);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(remeasure, REMEASURE_DEBOUNCE_MS);
    };

    syncFromScroller();
    const observers: (ResizeObserver | MutationObserver)[] = [];
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(schedule);
      ro.observe(scroll);
      observers.push(ro);
    }
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(schedule);
      mo.observe(scroll, { childList: true, subtree: true, characterData: true });
      observers.push(mo);
    }
    window.addEventListener('resize', schedule);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', schedule);
      for (const o of observers) o.disconnect();
    };
  }, [enabled, scrollRef, syncFromScroller, remeasureKey]);

  // Follow scrolls we didn't originate: browser find-in-page, focus
  // moving into an off-page element, an anchor jump.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    scroll.addEventListener('scroll', syncFromScroller, { passive: true });
    return () => scroll.removeEventListener('scroll', syncFromScroller);
  }, [enabled, scrollRef, syncFromScroller]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (keysBelongToWidget(e.target)) return;
      // A page turn under an open dialog or popover would scroll the
      // document out from under whatever the reader is actually using.
      if (document.querySelector('[role="dialog"], [data-state="open"][role="menu"]')) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          turn(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          turn(-1);
          break;
        case ' ':
          // Space still has to activate a focused control.
          if (e.target instanceof HTMLElement && e.target.closest('button, a, [role="button"]')) {
            return;
          }
          turn(e.shiftKey ? -1 : 1);
          break;
        case 'Home':
          goTo(0);
          break;
        case 'End':
          goTo(Number.MAX_SAFE_INTEGER);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, turn, goTo]);

  useEffect(() => {
    const surface = gestureSurfaceOf(scrollRef.current);
    if (!enabled || !surface) return;

    let lastTurnAt = 0;
    let accumulated = 0;
    const onWheel = (e: WheelEvent) => {
      // A trackpad emits a long tail of small deltas per flick; take the
      // dominant axis so both a vertical scroll gesture and a horizontal
      // swipe turn the page.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastTurnAt < WHEEL_COOLDOWN_MS) return;
      accumulated += delta;
      if (Math.abs(accumulated) < WHEEL_MIN_DELTA) return;
      lastTurnAt = now;
      turn(accumulated > 0 ? 1 : -1);
      accumulated = 0;
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [enabled, scrollRef, turn]);

  useEffect(() => {
    const surface = gestureSurfaceOf(scrollRef.current);
    if (!enabled || !surface) return;

    let start: { x: number; y: number; at: number; hadSelection: boolean } | null = null;
    let latest: { x: number; y: number } | null = null;

    const settle = (x: number, y: number, at: number) => {
      const from = start;
      start = null;
      latest = null;
      if (!from) return;
      if (at - from.at > SWIPE_MAX_MS) return;
      // A long-press selection ends in a drag too — that one is the
      // reader marking a quote to comment on. Only a selection this
      // gesture *made* disqualifies it: one left over from earlier would
      // otherwise keep swiping dead until the reader thought to tap it
      // away, with nothing on screen to explain why.
      if (!from.hadSelection && window.getSelection()?.isCollapsed === false) return;
      const dx = x - from.x;
      const dy = y - from.y;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;
      lastSwipeAt.current = performance.now();
      turn(dx < 0 ? 1 : -1);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Mouse drags are text selection; only touch and pen swipe.
      if (e.pointerType === 'mouse') {
        start = null;
        return;
      }
      start = {
        x: e.clientX,
        y: e.clientY,
        at: e.timeStamp,
        hadSelection: window.getSelection()?.isCollapsed === false,
      };
      latest = { x: e.clientX, y: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (start) latest = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => settle(e.clientX, e.clientY, e.timeStamp);
    const onPointerCancel = (e: PointerEvent) => {
      // The browser claimed the gesture as a pan and will send nothing
      // more. If the finger had already travelled far enough sideways by
      // then, that was a page turn — dropping it is why a swipe can feel
      // like it simply does nothing.
      const last = latest;
      if (last) settle(last.x, last.y, e.timeStamp);
      else start = null;
    };
    surface.addEventListener('pointerdown', onPointerDown, { passive: true });
    surface.addEventListener('pointermove', onPointerMove, { passive: true });
    surface.addEventListener('pointerup', onPointerUp, { passive: true });
    surface.addEventListener('pointercancel', onPointerCancel, { passive: true });
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [enabled, scrollRef, turn]);

  return { page, pageCount, goTo, turn, tap };
}
