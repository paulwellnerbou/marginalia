import { useEffect, useRef, useState } from 'react';
import type { ProposalTarget } from './SelectionToolbar.js';

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  onPropose: (target: ProposalTarget) => void;
}

/**
 * Hover-trigger on every block that can carry a proposal — top-level
 * blocks (`[data-block]`) and sub-blocks like list items / table cells
 * (`[data-subblock]`). Renders a "Propose edit" button floating at the
 * block's top-right while the pointer is over it. Complements the
 * SelectionToolbar, which only appears on an active text selection.
 *
 * State tracking uses a single `mousemove` listener on `window`:
 *
 *   • cursor on the button   → state unchanged (button stays)
 *   • cursor inside root     → nearest sub/block id becomes the target
 *   • cursor elsewhere       → state cleared (button hides)
 *
 * No mouseover/mouseleave timer dance — the older `mouseleave`+timeout
 * approach had a narrow window where the hide timer fired before the
 * button's `mouseenter`, making the button vanish mid-trajectory. The
 * mousemove approach can't race because every frame's pointer position
 * fully determines the visible state.
 *
 * The button uses `position: fixed` because the document scrolls inside
 * a nested pane, not the viewport — `getBoundingClientRect()` already
 * yields viewport coordinates.
 */
export function BlockActions({ rootRef, onPropose }: Props) {
  const [target, setTarget] = useState<{
    blockId: string;
    rect: DOMRect;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function update(e: MouseEvent) {
      const t = e.target instanceof HTMLElement ? e.target : null;

      // 1. Hovering the button (or its children, though there are none)
      //    keeps the current target visible.
      if (t && btnRef.current && (t === btnRef.current || btnRef.current.contains(t))) {
        return;
      }

      // 2. Outside the document pane entirely → clear.
      if (!t || !root!.contains(t)) {
        setTarget((prev) => (prev === null ? prev : null));
        return;
      }

      // 3. Inside root — find nearest proposal-targetable block.
      const block = closestBlock(t);
      if (!block) {
        setTarget((prev) => (prev === null ? prev : null));
        return;
      }
      const blockId = block.dataset.subblock ?? block.dataset.block;
      if (!blockId) return;
      setTarget((prev) => {
        if (prev && prev.blockId === blockId) return prev;
        return { blockId, rect: block.getBoundingClientRect() };
      });
    }

    function onScroll() {
      // Hide while scrolling — stale rect would put the button in the wrong place.
      setTarget(null);
    }

    window.addEventListener('mousemove', update);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousemove', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef]);

  if (!target) return null;

  function propose() {
    const root = rootRef.current;
    if (!root || !target) return;
    const escaped = CSS.escape(target.blockId);
    const el = root.querySelector<HTMLElement>(
      `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
    );
    if (!el) return;
    const blockText = (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
    onPropose({ block_id: target.blockId, block_text: blockText });
    setTarget(null);
  }

  // position: fixed — viewport-relative.
  // Sit on the block's top-right corner, overlapping into the block by
  // ~16px so the cursor can glide from block to button without ever
  // leaving a hit target.
  const style: React.CSSProperties = {
    top: Math.max(4, target.rect.top - 4),
    left: Math.max(4, target.rect.right - 16),
  };

  return (
    <button
      ref={btnRef}
      type="button"
      className="block-actions-btn"
      style={style}
      onClick={propose}
      title="Propose an edit to this block"
      aria-label="Propose an edit to this block"
    >
      ✎ Propose edit
    </button>
  );
}

function closestBlock(node: Node): HTMLElement | null {
  // Returns the nearest proposal-targetable ancestor — either a top-level
  // block (`data-block`) or a fine-grained sub-block (`data-subblock`
  // on list items / table cells). Sub-blocks naturally win when both
  // are present because we walk upward and stop at the first match.
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && (n.dataset.subblock || n.dataset.block)) return n;
    n = n.parentNode;
  }
  return null;
}
