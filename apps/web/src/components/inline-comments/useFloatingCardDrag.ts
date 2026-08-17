import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { clampCardOffset } from './floatingCardPosition.js';

/** How far one arrow press pushes the card; Shift multiplies it. */
const NUDGE_PX = 24;
const NUDGE_FAST_FACTOR = 4;
/** Pointer travel under this is a tap on the handle, not a drag. */
const DRAG_SLOP_PX = 4;

const NO_OFFSET = { dx: 0, dy: 0 } as const;

export interface FloatingCardDragOptions {
  /** The measured card. Its size bounds how far it may be pushed. */
  cardEl: HTMLElement | null;
  /** Positioning host the offsets are relative to. */
  hostRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Anchored position from `useFloatingCardPlacement`. */
  pos: { top: number; left: number } | null;
  /** Identity of what is being placed; a change drops the offset. */
  resetKey: unknown;
}

export interface FloatingCardDrag {
  offset: { dx: number; dy: number };
  /** The card is somewhere other than where its anchor put it. */
  moved: boolean;
  dragging: boolean;
  /** Bind to the drag handle. */
  handleProps: {
    onPointerDown: (event: PointerEvent) => void;
    onKeyDown: (event: KeyboardEvent) => void;
  };
}

/**
 * Let the reader shove an anchored popover card aside — the text it
 * hangs over is often the text they want to read.
 *
 * The result is an offset on top of the anchored position, not a
 * position of its own, so a moved card still follows its anchor through
 * reflows, doc swaps and re-placements. Dragging is confined to an
 * explicit handle: the whole point is reading and copying what is
 * underneath, which a card-wide grab area would break.
 */
export function useFloatingCardDrag({
  cardEl,
  hostRef,
  scrollContainerRef,
  pos,
  resetKey,
}: FloatingCardDragOptions): FloatingCardDrag {
  const [offset, setOffset] = useState<{ dx: number; dy: number }>(NO_OFFSET);
  const [dragging, setDragging] = useState(false);
  // Mirrors for the event handlers, written eagerly rather than from an
  // effect: pointermove and key repeats fire faster than React
  // re-renders, and each one is relative to where the last one left the
  // card. Reading that back from state would drop every step but the
  // last of any burst inside one task.
  const offsetRef = useRef(offset);
  const posRef = useRef(pos);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  const clamp = useCallback(
    (dx: number, dy: number) => {
      const base = posRef.current;
      const host = hostRef.current;
      const scroll = scrollContainerRef.current;
      if (!base || !host || !scroll || !cardEl) return { dx, dy };
      const hostRect = host.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      if (hostRect.width <= 0 || cardRect.width <= 0) return { dx, dy };
      return clampCardOffset({
        baseTop: base.top,
        baseLeft: base.left,
        dx,
        dy,
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
        hostWidth: hostRect.width,
        viewTop: scrollRect.top - hostRect.top,
        viewHeight: scroll.clientHeight,
      });
    },
    [cardEl, hostRef, scrollContainerRef],
  );

  const apply = useCallback((next: { dx: number; dy: number }) => {
    offsetRef.current = next;
    setOffset((prev) => (prev.dx === next.dx && prev.dy === next.dy ? prev : next));
  }, []);

  const move = useCallback(
    (dx: number, dy: number) => {
      apply(clamp(dx, dy));
    },
    [apply, clamp],
  );

  const reset = useCallback(() => {
    apply(NO_OFFSET);
  }, [apply]);

  // A different card in the slot starts where its own anchor puts it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the identity of what is being moved; `reset` only clears state.
  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  // Re-place passes move the base underneath a card the reader already
  // pushed somewhere — after a scroll-settle re-place the same offset
  // can land it off screen. Re-trim it against the new base.
  useEffect(() => {
    if (!pos) return;
    if (offsetRef.current.dx === 0 && offsetRef.current.dy === 0) return;
    move(offsetRef.current.dx, offsetRef.current.dy);
  }, [pos, move]);

  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Suppresses the text selection a drag off the handle would
      // otherwise start; the click event it may also cost us is unused,
      // taps are handled on pointerup below.
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const base = offsetRef.current;
      let dragged = false;
      setDragging(true);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) <= DRAG_SLOP_PX) return;
        dragged = true;
        move(base.dx + dx, base.dy + dy);
      };
      const onEnd = (ev: globalThis.PointerEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
        setDragging(false);
        // Tapping the handle sends the card back to its anchor — the
        // only way back other than closing and reopening the thread.
        if (ev.type === 'pointerup' && !dragged) reset();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    },
    [move, reset],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reset();
        return;
      }
      const step = event.shiftKey ? NUDGE_PX * NUDGE_FAST_FACTOR : NUDGE_PX;
      let dx = 0;
      let dy = 0;
      if (event.key === 'ArrowLeft') dx = -step;
      else if (event.key === 'ArrowRight') dx = step;
      else if (event.key === 'ArrowUp') dy = -step;
      else if (event.key === 'ArrowDown') dy = step;
      else return;
      event.preventDefault();
      const cur = offsetRef.current;
      move(cur.dx + dx, cur.dy + dy);
    },
    [move, reset],
  );

  return {
    offset,
    moved: offset.dx !== 0 || offset.dy !== 0,
    dragging,
    handleProps: { onPointerDown, onKeyDown },
  };
}
