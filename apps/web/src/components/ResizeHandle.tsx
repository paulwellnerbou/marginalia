import { useEffect, useRef } from 'react';

interface Props {
  /** Which side of the pane this handle lives on — tells us how mouse Δ
   *  translates to a width change. */
  side: 'left' | 'right';
  /** Current pane width in px. */
  width: number;
  /** Called with the new width while dragging. */
  onResize: (px: number) => void;
  /** Called once with the width a drag or key step settled on — the place
   *  to persist it, rather than on every pixel of the drag. */
  onResizeEnd?: (px: number) => void;
  /** Allowed range. */
  min?: number;
  max?: number;
  /** Accessible label, e.g. "Resize assets panel". */
  label?: string;
}

const STEP = 16;
const STEP_LARGE = 48;

/**
 * Marks a resize as in progress for the stylesheet, which uses it to drop
 * the pane-collapse easing (see `.pane-resizing` in app.css): a width the
 * user is dragging or stepping has to land where they put it, not glide
 * there a fifth of a second later.
 */
function markResizing(active: boolean): void {
  document.body.classList.toggle('pane-resizing', active);
}

/**
 * Vertical drag handle used to resize a side pane. Supports mouse drag and
 * keyboard (Arrow keys, Shift+Arrow for larger steps).
 */
export function ResizeHandle({
  side,
  width,
  onResize,
  onResizeEnd,
  min = 160,
  max = 640,
  label = 'Resize pane',
}: Props) {
  const dragging = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragging.current;
      if (!d) return;
      const deltaX = e.clientX - d.startX;
      const signed = side === 'left' ? deltaX : -deltaX;
      const next = Math.max(min, Math.min(max, d.startWidth + signed));
      d.last = next;
      onResize(next);
    }
    function onUp() {
      const d = dragging.current;
      if (!d) return;
      dragging.current = null;
      if (d.last !== d.startWidth) onResizeEnd?.(d.last);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      markResizing(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Releasing the button after switching away never reaches the page, so
    // without this the drag outlives the gesture: the pane would follow a
    // mouse nobody is holding, over a layout still stripped of its easing.
    // Ending it here leaves the pane at the width it had when focus went.
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [side, onResize, onResizeEnd, min, max]);

  // Unmounting mid-drag (the handle goes away with the pane it resizes)
  // would otherwise leave the whole layout unanimated.
  useEffect(() => () => markResizing(false), []);

  function clamp(v: number) {
    return Math.max(min, Math.min(max, v));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot carry the interactive resize behaviour
    <div
      className={`resize-handle resize-handle-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label}
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = { startX: e.clientX, startWidth: width, last: width };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        markResizing(true);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP_LARGE : STEP;
        const delta = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : null;
        if (delta === null) return;
        e.preventDefault();
        markResizing(true);
        const next = clamp(width + (side === 'left' ? delta : -delta));
        // Already at the limit: nothing moved, so nothing to store.
        if (next === width) return;
        onResize(next);
        onResizeEnd?.(next);
      }}
      onKeyUp={() => markResizing(false)}
      onBlur={() => markResizing(false)}
    />
  );
}
