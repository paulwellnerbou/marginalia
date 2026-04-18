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
 * block's right edge while the pointer is over it. Complements the
 * SelectionToolbar, which only appears on an active text selection.
 *
 * The button uses `position: fixed` because the document scrolls inside a
 * nested pane, not the viewport. `getBoundingClientRect()` already yields
 * viewport coordinates, so no scroll offsets are added — any hover-anchor
 * drift on scroll is handled by hiding the button while scrolling.
 */
export function BlockActions({ rootRef, onPropose }: Props) {
  const [target, setTarget] = useState<{
    blockId: string;
    rect: DOMRect;
  } | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function show(el: HTMLElement) {
      const blockId = el.dataset.subblock ?? el.dataset.block;
      if (!blockId) return;
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setTarget({ blockId, rect: el.getBoundingClientRect() });
    }

    function scheduleHide() {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setTarget(null), 200);
    }

    function onOver(e: MouseEvent) {
      const path = e.target;
      if (!(path instanceof Node)) return;
      const block = closestBlock(path);
      if (block && root!.contains(block)) show(block);
    }

    function onLeave(e: MouseEvent) {
      const to = e.relatedTarget;
      if (to instanceof Node && root!.contains(to)) return;
      scheduleHide();
    }

    function onScroll() {
      // Positions would drift with the scrolling pane; just hide.
      setTarget(null);
    }

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseleave', onLeave);
    // capture=true so we catch scrolls on the nested scroll container
    // (the document pane), not just window.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('scroll', onScroll, true);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
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

  // position: fixed — viewport-relative, immune to offsetParent / scroll
  // context mismatches. `getBoundingClientRect()` is already viewport space.
  //
  // Sit on the block's right edge, overlapping by ~10px so the cursor
  // can glide from the block onto the button without ever leaving a hit
  // target. A gap (previous +6px offset) would fire mouseleave on the
  // block; if the 200ms hide-timer ran out before mouseenter on the
  // button arrived, the button vanished mid-trajectory — the bug the
  // user reported.
  const style: React.CSSProperties = {
    top: target.rect.top - 4,
    left: target.rect.right - 10,
  };

  return (
    <button
      type="button"
      className="block-actions-btn"
      style={style}
      onClick={propose}
      onMouseEnter={() => {
        if (hideTimer.current !== null) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      }}
      onMouseLeave={() => setTarget(null)}
      title="Propose an edit to this paragraph"
      aria-label="Propose an edit to this paragraph"
    >
      ✎ Propose edit
    </button>
  );
}

function closestBlock(node: Node): HTMLElement | null {
  // Returns the nearest proposal-targetable ancestor — either a top-level
  // block (`data-block`) or a fine-grained sub-block (`data-subblock`
  // on list items / table cells). Sub-blocks win when both are present
  // because they're always inside a parent block.
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && (n.dataset.subblock || n.dataset.block)) return n;
    n = n.parentNode;
  }
  return null;
}
