import { useEffect, useState } from 'react';
import { captureSelection, selectionRect } from '../lib/selection.js';
import type { CommentAnchor } from '../lib/api.js';

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  onAdd: (anchor: CommentAnchor) => void;
}

/**
 * Floating "Add comment" chip that appears next to a text selection made
 * inside the document pane. Click → captures the anchor and calls onAdd.
 */
export function SelectionToolbar({ rootRef, onAdd }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const handle = () => {
      const root = rootRef.current;
      if (!root) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setRect(null);
        return;
      }
      if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        setRect(null);
        return;
      }
      setRect(selectionRect());
    };
    document.addEventListener('selectionchange', handle);
    return () => document.removeEventListener('selectionchange', handle);
  }, [rootRef]);

  if (!rect) return null;

  return (
    <button
      className="selection-toolbar"
      style={{
        top: rect.top + window.scrollY - 40,
        left: rect.left + window.scrollX + rect.width / 2,
      }}
      // mousedown to fire before selectionchange clears it
      onMouseDown={(e) => {
        e.preventDefault();
        const root = rootRef.current;
        if (!root) return;
        const anchor = captureSelection(root);
        if (anchor) onAdd(anchor);
        setRect(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      + Comment
    </button>
  );
}
