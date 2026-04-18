import { useEffect, useRef, useState } from 'react';
import type { ProposalTarget } from './SelectionToolbar.js';

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  onPropose: (target: ProposalTarget) => void;
}

/**
 * Hover-trigger on every top-level block (`[data-block]`) — renders a
 * "Propose edit" button floating at the block's right edge while the
 * pointer is over it. Complements the SelectionToolbar, which only
 * appears on an active text selection.
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
      const blockId = el.dataset.block;
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
    const el = root.querySelector<HTMLElement>(
      `[data-block="${CSS.escape(target.blockId)}"]`,
    );
    if (!el) return;
    const blockText = (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
    onPropose({ block_id: target.blockId, block_text: blockText });
    setTarget(null);
  }

  // position: fixed — viewport-relative, immune to offsetParent / scroll
  // context mismatches. `getBoundingClientRect()` is already viewport space.
  const style: React.CSSProperties = {
    top: target.rect.top + 2,
    left: target.rect.right + 6,
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
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && n.dataset.block) return n;
    n = n.parentNode;
  }
  return null;
}
