import { useEffect, useRef } from 'react';

interface Props {
  /** Which side of the pane this handle lives on — tells us how mouse Δ
   *  translates to a width change. */
  side: 'left' | 'right';
  /** Current pane width in px. */
  width: number;
  /** Called with the new width while dragging. */
  onResize: (px: number) => void;
  /** Allowed range. */
  min?: number;
  max?: number;
  /** Accessible label, e.g. "Resize assets panel". */
  label?: string;
}

const STEP = 16;
const STEP_LARGE = 48;

/**
 * Vertical drag handle used to resize a side pane. Supports mouse drag and
 * keyboard (Arrow keys, Shift+Arrow for larger steps).
 */
export function ResizeHandle({
  side,
  width,
  onResize,
  min = 160,
  max = 640,
  label = 'Resize pane',
}: Props) {
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragging.current;
      if (!d) return;
      const deltaX = e.clientX - d.startX;
      const signed = side === 'left' ? deltaX : -deltaX;
      const next = Math.max(min, Math.min(max, d.startWidth + signed));
      onResize(next);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [side, onResize, min, max]);

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
        dragging.current = { startX: e.clientX, startWidth: width };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP_LARGE : STEP;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onResize(clamp(width + (side === 'left' ? step : -step)));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onResize(clamp(width + (side === 'left' ? -step : step)));
        }
      }}
    />
  );
}
