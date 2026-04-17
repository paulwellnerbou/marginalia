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
}

/**
 * Vertical drag handle used to resize a side pane. No dependencies — pure
 * mouse events + document listeners while dragging.
 */
export function ResizeHandle({ side, width, onResize, min = 160, max = 640 }: Props) {
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

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = { startX: e.clientX, startWidth: width };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
    />
  );
}
