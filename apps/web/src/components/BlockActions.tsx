import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProposalTarget } from './SelectionToolbar.js';

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  onPropose: (target: ProposalTarget) => void;
}

const BLOCK_ACTIONS_FADE_OUT_MS = 260;

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
  const [hoveredTarget, setHoveredTarget] = useState<{
    blockId: string;
    rect: DOMRect;
  } | null>(null);
  const [renderedTarget, setRenderedTarget] = useState<{
    blockId: string;
    rect: DOMRect;
  } | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const [buttonSize, setButtonSize] = useState({ width: 0, height: 0 });

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
      if (!t || !rootRef.current || !rootRef.current.contains(t)) {
        setHoveredTarget((prev) => (prev === null ? prev : null));
        return;
      }

      // 3. Inside root — find nearest proposal-targetable block.
      const block = closestBlock(t);
      if (!block) {
        const btnRect = btnRef.current?.getBoundingClientRect() ?? null;
        const activeRect = hoveredTarget?.rect ?? renderedTarget?.rect ?? null;
        if (
          btnRect &&
          activeRect &&
          isWithinHoverBridge(e.clientX, e.clientY, activeRect, btnRect)
        ) {
          return;
        }
        setHoveredTarget((prev) => (prev === null ? prev : null));
        return;
      }
      const blockId = block.dataset.subblock ?? block.dataset.block;
      if (!blockId) return;
      setHoveredTarget((prev) => {
        if (prev && prev.blockId === blockId) return prev;
        return { blockId, rect: block.getBoundingClientRect() };
      });
    }

    function onScroll() {
      // Hide while scrolling — stale rect would put the button in the wrong place.
      setHoveredTarget(null);
    }

    window.addEventListener('mousemove', update);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousemove', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [hoveredTarget, renderedTarget, rootRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: renderedTarget is the re-attach trigger so the observer re-binds whenever the floating button is re-shown for a different block.
  useLayoutEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;

    const measure = () => {
      const rect = btn.getBoundingClientRect();
      setButtonSize((prev) => {
        const nextWidth = Math.ceil(rect.width);
        const nextHeight = Math.ceil(rect.height);
        if (prev.width === nextWidth && prev.height === nextHeight) return prev;
        return { width: nextWidth, height: nextHeight };
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(btn);
    return () => observer.disconnect();
  }, [renderedTarget]);

  useEffect(() => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    if (!hoveredTarget) {
      setIsVisible(false);
      return;
    }

    setRenderedTarget(hoveredTarget);
    const frame = window.requestAnimationFrame(() => setIsVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [hoveredTarget]);

  useEffect(() => {
    if (isVisible || !renderedTarget) return;

    hideTimeoutRef.current = window.setTimeout(() => {
      hideTimeoutRef.current = null;
      setRenderedTarget(null);
    }, BLOCK_ACTIONS_FADE_OUT_MS);

    return () => {
      if (hideTimeoutRef.current !== null) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
    };
  }, [isVisible, renderedTarget]);

  if (!renderedTarget) return null;

  function propose() {
    const root = rootRef.current;
    if (!root || !renderedTarget) return;
    const escaped = CSS.escape(renderedTarget.blockId);
    const el = root.querySelector<HTMLElement>(
      `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
    );
    if (!el) return;
    const blockText = (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
    onPropose({ block_id: renderedTarget.blockId, block_text: blockText, block_count: 1 });
    setHoveredTarget(null);
  }

  // position: fixed — viewport-relative.
  // Keep the button just above the block instead of hanging out in the
  // right gutter. That matches the user's cursor path better, especially
  // on paragraphs whose box stretches wider than the visible text.
  const buttonWidth = buttonSize.width || 124;
  const buttonHeight = buttonSize.height || 28;
  const style: React.CSSProperties = {
    top: Math.max(4, renderedTarget.rect.top - buttonHeight + 6),
    left: Math.max(4, renderedTarget.rect.right - buttonWidth - 8),
  };

  return (
    <button
      ref={btnRef}
      type="button"
      className={isVisible ? 'block-actions-btn is-visible' : 'block-actions-btn'}
      style={style}
      onClick={propose}
      title="Propose an edit to this block"
      aria-label="Propose an edit to this block"
    >
      ✎ Propose edit
    </button>
  );
}

function isWithinHoverBridge(
  x: number,
  y: number,
  targetRect: DOMRect,
  buttonRect: DOMRect,
): boolean {
  const verticalReach = Math.min(34, Math.max(18, targetRect.height * 0.28));
  const top = Math.min(buttonRect.top, targetRect.top) - 10;
  const bottom = Math.max(buttonRect.bottom, targetRect.top + verticalReach) + 10;
  const left =
    Math.min(buttonRect.left, targetRect.right - Math.max(buttonRect.width + 24, 120)) - 10;
  const right = Math.max(buttonRect.right, targetRect.right) + 10;
  return x >= left && x <= right && y >= top && y <= bottom;
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
