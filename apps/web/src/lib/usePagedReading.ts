import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { clampPage, goToPage, measurePages, pageIndexOfClientRect } from './paged-reading.js';

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
/** Quiet time after the last scroll before noting where the reader is (ms). */
const HELD_PLACE_SETTLE_MS = 200;
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
  /**
   * True once the pagination is wider than this engine will paint, so
   * every page past the first would come up blank. Nothing here acts on
   * it — the caller decides what to offer the reader instead.
   */
  tooWideToPaint: boolean;
}

/**
 * Inline extent past which WebKit stops painting a multi-column box: the
 * columns are laid out and measurable, `getBoundingClientRect` places
 * them correctly, and the screen stays empty. Observed on iPadOS 26 at
 * around 64k CSS px — a ~180-page document at a large text size, or a
 * book-length one at any size. Blink has no such limit.
 *
 * Kept a little under 2^16 for the sub-page slack in the last column.
 */
const PAGED_MAX_PAINTABLE_PX = 60000;

/**
 * True on engines with the painting limit above. Engine-sniffed on
 * purpose: the failure is a silent paint bug with nothing to feature-
 * detect, and capping every engine to WebKit's limit would take paged
 * mode away from readers whose browser handles it fine.
 */
function limitsMulticolPaint(): boolean {
  return /^Apple/.test(navigator.vendor ?? '');
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

/**
 * True while some block between `target` and the gesture surface can
 * still absorb this wheel gesture itself — a code block clamped to the
 * page, a long comment card. Paged mode creates those scrollers on
 * purpose; turning the page instead of scrolling them would put their
 * overflow out of reach of the wheel entirely.
 */
function absorbsWheel(
  target: EventTarget | null,
  deltaX: number,
  deltaY: number,
  surface: HTMLElement,
): boolean {
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const delta = vertical ? deltaY : deltaX;
  let el = target instanceof Element ? target : null;

  while (el && el !== surface) {
    if (el instanceof HTMLElement) {
      const style = window.getComputedStyle(el);
      const scrollable = /auto|scroll/.test(vertical ? style.overflowY : style.overflowX);
      const position = vertical ? el.scrollTop : el.scrollLeft;
      const extent = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      // Only while it has somewhere left to go in this direction —
      // otherwise a code block scrolled to its last line would swallow
      // every further flick and strand the reader on the page.
      if (scrollable && extent > 1 && (delta < 0 ? position > 1 : position < extent - 1)) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Where the reader is, as a position in the text: the words the page in
 * front of them opens with.
 *
 * Nothing about the *layout* survives a reflow usefully. A page number
 * is meaningless once the count changes. So is which column fragment of
 * a block the reader was on, since wider pages hold more text and the
 * same fragment index lands somewhere else entirely — that is a page
 * number wearing a different hat. And a block alone is too coarse:
 * `getBoundingClientRect()` reports the union of a block's fragments,
 * whose left edge names the first page it appears on however far into a
 * long paragraph the reader actually is. Only the text itself holds
 * still, so that is what gets remembered.
 */
interface HeldPlace {
  node: Node;
  offset: number;
}

/** Text position under a viewport point, across both spellings of the API. */
function caretAt(x: number, y: number): HeldPlace | null {
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

/** The text the current page opens with, or null where it can't be read. */
function heldPlaceOf(scroll: HTMLElement): HeldPlace | null {
  const box = scroll.getBoundingClientRect();
  const x = box.left + box.width / 2;
  // Down the middle of the column, from the first line inwards: the top
  // of a page can be page margin, the clearance above a heading, or the
  // tail of a floated figure, none of which sit on any text.
  for (const fraction of [0.04, 0.12, 0.25, 0.45, 0.7]) {
    const place = caretAt(x, box.top + box.height * fraction);
    // Overlays share the viewport with the scrollport — the floating
    // comment toolbar sits over the top of every page — so only a hit
    // inside the document itself counts.
    if (place?.node.parentElement?.closest('[data-block]') && scroll.contains(place.node)) {
      return place;
    }
  }
  return null;
}

/** The page a remembered position has landed on after a reflow. */
function pageOfHeldPlace(scroll: HTMLElement, held: HeldPlace): number | null {
  if (!held.node.isConnected) return null;
  const length = nodeLength(held.node);
  const start = Math.min(held.offset, length);
  const range = document.createRange();
  try {
    range.setStart(held.node, start);
    // One character wide where there is one: a collapsed range can
    // report an empty rect at a line boundary, which locates nothing.
    range.setEnd(held.node, Math.min(start + 1, length));
  } catch {
    return null;
  }
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.left === 0) return null;
  return pageIndexOfClientRect(scroll, rect);
}

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
  const [tooWideToPaint, setTooWideToPaint] = useState(false);

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
   * The block the reader was last looking at, noted while the layout was
   * still theirs. Re-measurement runs *after* the reflow that provoked
   * it, when the old geometry is already gone — asking then which block
   * is at the left edge answers with wherever the text happened to land,
   * which is exactly the drift this is meant to undo.
   */
  const heldPlace = useRef<HeldPlace | null>(null);
  /** Scrollport size and content extent as of the last re-measure. */
  const geometry = useRef<{ width: number; extent: number } | null>(null);

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
      // Both describe a pagination that no longer exists; carrying them
      // into the next paged session would re-anchor against it.
      heldPlace.current = null;
      geometry.current = null;
      setTooWideToPaint(false);
      return;
    }
    // Writing an inline custom property invalidates style for the whole
    // subtree, and re-fragmenting a book-length multicol document is the
    // most expensive thing on this page — so only write on a real change.
    const set = (el: HTMLElement, name: string, value: string) => {
      if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    };
    const publish = () => {
      // The column box's own height: the page margins are padding on
      // `.doc-body` and they aren't symmetric, and `clientHeight`
      // measures the padding box, so both have to come off.
      const column = scroll.querySelector<HTMLElement>('.doc-body');
      if (column) {
        const style = window.getComputedStyle(column);
        const height =
          column.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        set(scroll, '--doc-page-height', `${Math.max(0, Math.round(height))}px`);
      } else {
        set(scroll, '--doc-page-height', `${scroll.clientHeight}px`);
      }

      // The article spans every page, so its bounding rect is the union
      // of all of them; one client rect is one page's worth of it.
      const article = scroll.querySelector<HTMLElement>('article.marginalia');
      const fragment = article?.getClientRects()[0];
      const gutter = fragment ? (scroll.clientWidth - fragment.width) / 2 : 0;
      set(viewport, '--doc-page-gutter', `${Math.max(0, Math.round(gutter))}px`);
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
      const metrics = measurePages(scroll);
      setPageCount(metrics.pageCount);

      // Outlives this effect on purpose: a pane opening re-runs it, and a
      // baseline re-read afterwards would be the post-reflow geometry —
      // i.e. it would report that nothing had changed.
      const previous = geometry.current;
      const width = scroll.clientWidth;
      const extent = scroll.scrollWidth;
      geometry.current = { width, extent };
      setTooWideToPaint(limitsMulticolPaint() && extent > PAGED_MAX_PAINTABLE_PX);
      // Nothing moved — a highlight repaint, a mermaid swap. Re-snapping
      // would only risk nudging a reader mid-gesture.
      if (previous && previous.width === width && previous.extent === extent) {
        setPage(metrics.currentPage);
        return;
      }

      const held = heldPlace.current;
      const heldPage = held ? pageOfHeldPlace(scroll, held) : null;
      const target = clampPage(heldPage ?? metrics.currentPage, metrics.pageCount);
      // Unconditionally, even when the page index is unchanged: fewer
      // pages than before leaves `scrollLeft` pointing past the last one,
      // and nothing else brings it back — the reader is left swiping
      // through blank pages with the pager insisting they are at the end.
      goToPage(scroll, target, 'auto');
      setPage(target);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(remeasure, REMEASURE_DEBOUNCE_MS);
    };

    syncFromScroller();
    // `remeasureKey` is the one repagination trigger that fires no
    // observer of its own on some engines — a pane opening changes the
    // scrollport's width without touching anything inside it.
    schedule();
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

  // Note where the reader is once they have stopped moving, so the value
  // re-measurement reads was taken under the layout they were reading in.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    let timer = 0;
    const note = () => {
      heldPlace.current = heldPlaceOf(scroll);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(note, HELD_PLACE_SETTLE_MS);
    };
    schedule();
    scroll.addEventListener('scroll', schedule, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroll.removeEventListener('scroll', schedule);
    };
  }, [enabled, scrollRef]);

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
      if (absorbsWheel(e.target, e.deltaX, e.deltaY, surface)) return;
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

  return { page, pageCount, goTo, turn, tap, tooWideToPaint };
}
