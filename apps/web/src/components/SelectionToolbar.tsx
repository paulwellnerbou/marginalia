import { useEffect, useState } from 'react';
import { captureSelection, selectionRect } from '../lib/selection.js';
import type { CommentAnchor } from '../lib/api.js';

export interface ProposalTarget {
  block_id: string;
  /** Normalized plain text of the whole block, used as the quote snapshot. */
  block_text: string;
}

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  onAdd: (anchor: CommentAnchor) => void;
  onPropose?: (target: ProposalTarget) => void;
}

/**
 * Floating toolbar next to a text selection inside the document pane.
 * "+ Comment" captures the exact selection span. "Propose edit" expands
 * to the nearest proposal-targetable block — a top-level block
 * (paragraph, heading, code block, blockquote, list, table, …) OR a
 * sub-block (list item, table cell) when the selection is inside one.
 */
export function SelectionToolbar({ rootRef, onAdd, onPropose }: Props) {
  const [state, setState] = useState<{ rect: DOMRect; blockId: string | null } | null>(null);

  useEffect(() => {
    const handle = () => {
      const root = rootRef.current;
      if (!root) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setState(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setState(null);
        return;
      }
      const rect = selectionRect();
      if (!rect) {
        setState(null);
        return;
      }
      // Triple-click typically sets the selection end at offset 0 of the
      // *next* node, which makes `commonAncestorContainer` the parent of
      // the paragraph rather than the paragraph itself. Fall back to the
      // node where the selection starts — that's always inside the block
      // the user meant to act on.
      const blockEl =
        closestBlock(range.commonAncestorContainer) ?? closestBlock(range.startContainer);
      const blockId = blockEl?.dataset.subblock ?? blockEl?.dataset.block ?? null;
      setState({ rect, blockId });
    };
    document.addEventListener('selectionchange', handle);
    return () => document.removeEventListener('selectionchange', handle);
  }, [rootRef]);

  if (!state) return null;

  function doComment(e: React.MouseEvent) {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const anchor = captureSelection(root);
    if (anchor) onAdd(anchor);
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  function doPropose(e: React.MouseEvent) {
    e.preventDefault();
    const root = rootRef.current;
    if (!root || !state || !state.blockId) return;
    const escaped = CSS.escape(state.blockId);
    const blockEl = root.querySelector<HTMLElement>(
      `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
    );
    if (!blockEl) return;
    const blockText = (blockEl.textContent ?? '').replace(/\s+/gu, ' ').trim();
    onPropose?.({ block_id: state.blockId, block_text: blockText });
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div
      className="selection-toolbar"
      style={{
        top: state.rect.top + window.scrollY - 40,
        left: Math.max(
          60,
          Math.min(
            window.innerWidth - 60,
            state.rect.left + window.scrollX + state.rect.width / 2,
          ),
        ),
      }}
    >
      {/* mousedown so the handler fires before selectionchange clears the range */}
      <button type="button" onMouseDown={doComment}>+ Comment</button>
      {onPropose && state.blockId && (
        <button type="button" onMouseDown={doPropose}>Propose edit</button>
      )}
    </div>
  );
}

function closestBlock(node: Node): HTMLElement | null {
  // Returns the nearest proposal-targetable ancestor — either a top-level
  // block (`data-block`) or a fine-grained sub-block (`data-subblock`
  // on list items / table cells).
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && (n.dataset.subblock || n.dataset.block)) return n;
    n = n.parentNode;
  }
  return null;
}
