import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { clampPage, goToPage, measurePages, pageIndexOfClientRect } from './paged-reading.js';
import { isAppleWebKit } from './webkit.js';

/** Travel along the paging axis that counts as a page-turning swipe, in px. */
const SWIPE_MIN_PX = 48;
/** How much a swipe must favour the paging axis to not read as a scroll. */
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
/**
 * How long a programmatic turn is trusted to still be in flight. Only a
 * safety net for a smooth scroll that gets cancelled or never lands;
 * arriving at the target clears the wait immediately. Comfortably past a
 * one-page smooth scroll, which lands in about 300ms.
 */
const TURN_SETTLE_MS = 700;

export interface PagedReading {
  /** 0-based index of the page on screen. */
  page: number;
  pageCount: number;
  goTo: (index: number, behavior?: ScrollBehavior) => void;
  turn: (delta: number) => void;
  /** Turn from a tap on an edge zone, unless a swipe just handled it. */
  tap: (delta: number) => void;
  /**
   * True once the pagination runs further than this engine will paint,
   * so pages past a certain point come up blank. Nothing here acts on
   * it — the caller decides what to offer the reader instead.
   */
  tooWideToPaint: boolean;
}

/**
 * How far a page turn may scroll before WebKit stops painting the
 * columns. Past this the text is still laid out and measurable —
 * `getBoundingClientRect` places it correctly and the page counter is
 * right — and the screen is simply empty.
 *
 * Measured on iPadOS 26 (iPad Air, DPR 2) against a 222-page document
 * at a 747 px pitch: x=98,604 paints in full, x=114,291 and beyond are
 * blank. 90,000 sits under that with room to spare.
 *
 * Two things this is NOT, both established by experiment, so nobody
 * re-derives them: it is not a limit on the size of a single multicol
 * box (splitting the article into five boxes of under 40k px each did
 * not help), and it is not measured from the end of the document
 * (padding the scroller out to 236k px did not move the blank band).
 * Bare multicol markup with the same CSS paints past 349k px, so the
 * ceiling comes from something in this app that is still unidentified.
 *
 * How it scales beyond this one device is unknown — a higher-DPR phone
 * may well have a lower ceiling in CSS px. Erring low only costs a
 * reader paged mode on a very long document; erring high hands them a
 * blank page.
 */
const PAGED_MAX_PAINTABLE_PX = 90000;

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
 * and text-size steppers and the layout toggle all sit a tab-stop away
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
  /** Page down the block axis instead of across — see `PAGED_VERTICAL_CLASS`. */
  vertical = false,
): PagedReading {
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [tooWideToPaint, setTooWideToPaint] = useState(false);

  /**
   * The page a turn we started is on its way to. A smooth scroll reports
   * every offset it passes through, and the first half of the journey
   * still rounds to the page being left — so following those events
   * walks the counter back to the old page and forward again on every
   * single turn.
   */
  const pendingTurn = useRef<{ page: number; until: number } | null>(null);
  const settleTimer = useRef(0);

  const clearPendingTurn = useCallback(() => {
    pendingTurn.current = null;
    window.clearTimeout(settleTimer.current);
  }, []);

  /** Adopt a measured page unless a turn we started is still under way. */
  const acceptPage = useCallback(
    (measured: number) => {
      const pending = pendingTurn.current;
      if (pending) {
        // The timestamp releases the guard even where the timer below is
        // throttled — a background tab clamps timeouts to about a second.
        if (measured !== pending.page && performance.now() < pending.until) return;
        clearPendingTurn();
      }
      setPage(measured);
    },
    [clearPendingTurn],
  );

  const syncFromScroller = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const metrics = measurePages(scroll);
    setPageCount(metrics.pageCount);
    acceptPage(metrics.currentPage);
  }, [scrollRef, acceptPage]);

  /**
   * Start the wait for a scroll we just asked for. The deadline has to
   * arrive under its own power: a cancelled scroll — the reader grabbing
   * the scrollbar mid-turn — delivers no further event, so the last one
   * the guard ignored would be the last one there is, and the counter
   * would sit on a page nobody is on.
   */
  const beginTurn = useCallback(
    (target: number) => {
      pendingTurn.current = { page: target, until: performance.now() + TURN_SETTLE_MS };
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        clearPendingTurn();
        syncFromScroller();
      }, TURN_SETTLE_MS);
    },
    [clearPendingTurn, syncFromScroller],
  );

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const goTo = useCallback(
    (index: number, behavior: ScrollBehavior = 'smooth') => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const { pageCount: total } = measurePages(scroll);
      const next = clampPage(index, total);
      goToPage(scroll, next, behavior);
      beginTurn(next);
      // Optimistic: a programmatic scroll's own event is the only other
      // thing that would move the indicator, and it can be throttled or
      // (in embedded browsers) never delivered at all.
      setPageCount(total);
      setPage(next);
    },
    [scrollRef, beginTurn],
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
  /**
   * Page pitch and content extent as of the last re-measure, both along
   * the paging axis. Watching the *width* would be silently useless
   * where the pages run downwards: neither it nor `scrollWidth` moves
   * when that document repaginates, so every re-measure would report
   * that nothing had changed and the reader would never be re-anchored.
   */
  const geometry = useRef<{ pitch: number; extent: number } | null>(null);
  /**
   * The disabled branch also reruns when `remeasureKey` changes. Remember the
   * previous mode so changing document HTML in ordinary scroll reading does
   * not look like another request to leave pagination and jump to the top.
   */
  const wasEnabled = useRef(enabled);

  /**
   * Publish the page box in px for the CSS that can't derive it: the
   * height clamps oversized media, the gutter sizes the edge tap zones.
   * Both have to be measured — `100%` of an auto-height ancestor is
   * meaningless, and the reading width is authored in `ch`, which would
   * resolve against the wrong font anywhere outside the article.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasureKey is a pure trigger — reading width, zoom, theme and pane widths all move the page box.
  useEffect(() => {
    const leavingPagedMode = wasEnabled.current && !enabled;
    wasEnabled.current = enabled;

    // Clear pagination state on the mode transition even if the document is
    // temporarily unmounted. Otherwise this effect can miss the transition
    // and carry stale page geometry into the next paged session.
    if (leavingPagedMode) {
      setPage(0);
      setPageCount(1);
      heldPlace.current = null;
      geometry.current = null;
      clearPendingTurn();
      setTooWideToPaint(false);
    }

    const scroll = scrollRef.current;
    const viewport = gestureSurfaceOf(scroll);
    if (!scroll || !viewport) return;
    if (!enabled) {
      scroll.style.removeProperty('--doc-page-height');
      scroll.style.removeProperty('--doc-page-block');
      viewport.style.removeProperty('--doc-page-gutter');
      if (leavingPagedMode) {
        scroll.scrollLeft = 0;
        scroll.scrollTop = 0;
      }
      return;
    }
    // Writing an inline custom property invalidates style for the whole
    // subtree, and re-fragmenting a book-length multicol document is the
    // most expensive thing on this page — so only write on a real change.
    const set = (el: HTMLElement, name: string, value: string) => {
      if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    };
    const publish = () => {
      // Vertical pages are slices of ordinary flow, so nothing stops a
      // slice landing through the middle of a line. Trim the scrollport
      // to a whole number of lines and the break lands between them.
      // The remainder is left over inside the viewport, which centres
      // the scrollport and so becomes the page's top and bottom margin.
      if (vertical) {
        const article = scroll.querySelector<HTMLElement>('article.marginalia');
        const sample = article?.querySelector<HTMLElement>('p') ?? article;
        const lineHeight = sample ? parseFloat(window.getComputedStyle(sample).lineHeight) : NaN;
        // Reserve `--page-margin-block` above and below. It is authored
        // in `rem`, so it resolves against the root font size — reading
        // the scrollport's own would track the reader's text zoom and
        // quietly shrink the page every time they enlarged the text.
        const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const margin = Number.isFinite(rootFontSize) ? rootFontSize * 2 : 0;
        const available = viewport.clientHeight - margin * 2;
        const block =
          Number.isFinite(lineHeight) && lineHeight > 0
            ? Math.max(lineHeight, Math.floor(available / lineHeight) * lineHeight)
            : available;
        // Deliberately not rounded: line heights are routinely fractional
        // (19px at 1.6 is 30.4), and a page rounded to whole pixels is no
        // longer a whole number of lines. The error is under a pixel per
        // page but it is one-directional, so a hundred pages in it is a
        // whole line and the reader is looking at the top half of one.
        // `pitchOf` reads the same fractional height back.
        set(scroll, '--doc-page-block', `${Math.max(0, block)}px`);
      } else if (scroll.style.getPropertyValue('--doc-page-block')) {
        scroll.style.removeProperty('--doc-page-block');
      }

      // The column box's own height: the page margins are padding on
      // `.doc-body` and they aren't symmetric, and `clientHeight`
      // measures the padding box, so both have to come off.
      const column = vertical ? null : scroll.querySelector<HTMLElement>('.doc-body');
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
      scroll.style.removeProperty('--doc-page-block');
      viewport.style.removeProperty('--doc-page-gutter');
    };
  }, [enabled, vertical, scrollRef, remeasureKey]);

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
      // `metrics.pitch` is already the scrollport along whichever axis
      // the pages run on, fractional part and all.
      const extent = vertical ? scroll.scrollHeight : scroll.scrollWidth;
      geometry.current = { pitch: metrics.pitch, extent };
      // The paint limit is about sideways travel specifically, so it
      // reads `scrollWidth` whatever the pages are doing.
      setTooWideToPaint(
        !vertical && isAppleWebKit() && scroll.scrollWidth > PAGED_MAX_PAINTABLE_PX,
      );
      // Nothing moved — a highlight repaint, a mermaid swap. Re-snapping
      // would only risk nudging a reader mid-gesture.
      if (previous && previous.pitch === metrics.pitch && previous.extent === extent) {
        acceptPage(metrics.currentPage);
        return;
      }

      const held = heldPlace.current;
      const heldPage = held ? pageOfHeldPlace(scroll, held) : null;
      // A rendered-document refresh replaces every text node, so the held
      // range is deliberately disconnected and cannot name its new page.
      // Keep the page the reader was on in that case. `metrics.currentPage`
      // is derived from the old pixel offset divided by the *new* pitch; a
      // width change during the same refresh can otherwise turn page 225
      // into page 228 even though nobody asked to turn a page.
      const target = clampPage(heldPage ?? pageRef.current, metrics.pageCount);
      // Unconditionally, even when the page index is unchanged: fewer
      // pages than before leaves `scrollLeft` pointing past the last one,
      // and nothing else brings it back — the reader is left swiping
      // through blank pages with the pager insisting they are at the end.
      goToPage(scroll, target, 'auto');
      // Same guard as a turn: an instant scroll still delivers its event
      // a frame later, and on a shrinking document that event can arrive
      // reporting the offset from before the jump.
      beginTurn(target);
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
  }, [enabled, vertical, scrollRef, syncFromScroller, acceptPage, beginTurn, remeasureKey]);

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
      // A swipe turns the page along whichever axis the pages run on,
      // and has to clearly favour it over the other one to count.
      const along = vertical ? y - from.y : x - from.x;
      const across = vertical ? x - from.x : y - from.y;
      if (Math.abs(along) < SWIPE_MIN_PX || Math.abs(along) < Math.abs(across) * SWIPE_AXIS_RATIO) {
        return;
      }
      lastSwipeAt.current = performance.now();
      turn(along < 0 ? 1 : -1);
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
  }, [enabled, vertical, scrollRef, turn]);

  return { page, pageCount, goTo, turn, tap, tooWideToPaint };
}
