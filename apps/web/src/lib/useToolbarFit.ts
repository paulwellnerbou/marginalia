import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { nextFitStage } from './toolbar-fit.js';

/**
 * The first fold stage at which a flex row's controls fit without
 * scrolling. Measured rather than set by a breakpoint: what the row holds
 * depends on the reader's role and the interface scale, and the pane it
 * sits in is resizable.
 *
 * `resetKey` names whatever resizes the controls a folded stage no longer
 * shows; a change drops the stored widths and starts again from the full
 * row. Every step runs in a layout effect, so a stage that doesn't fit is
 * never painted.
 */
export function useToolbarFit(
  ref: RefObject<HTMLElement | null>,
  lastStage: number,
  resetKey: string,
): number {
  const [stage, setStage] = useState(0);
  const needed = useRef<number[]>([]);
  const measuredKey = useRef(resetKey);

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    if (measuredKey.current !== resetKey) {
      measuredKey.current = resetKey;
      needed.current = [];
      if (stage !== 0) {
        setStage(0);
        return;
      }
    }

    const measure = () => {
      // Not laid out (a hidden pane): nothing to learn from its width.
      if (row.clientWidth <= 0) return;
      needed.current[stage] = rowWidth(row);
      const next = nextFitStage(stage, needed.current, row.clientWidth, lastStage);
      if (next !== stage) setStage(next);
    };
    measure();

    // The row's own box follows the pane; its children's boxes catch a
    // control that grows in place, such as a label whose font arrives late.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer) {
      observer.observe(row);
      for (const child of row.children) observer.observe(child);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, stage, lastStage, resetKey]);

  return stage;
}

/**
 * What the row's content needs, whatever width it was given. Its own
 * `scrollWidth` would do only while it overflows: when it fits, a spacer
 * soaks up the slack and the row reports exactly the width it has.
 */
function rowWidth(row: HTMLElement): number {
  const style = getComputedStyle(row);
  let width = px(style.paddingLeft) + px(style.paddingRight);
  let items = 0;
  for (const child of row.children) {
    const childStyle = getComputedStyle(child);
    if (childStyle.display === 'none' || childStyle.position === 'absolute') continue;
    items += 1;
    if (Number(childStyle.flexGrow) > 0) continue;
    width +=
      child.getBoundingClientRect().width + px(childStyle.marginLeft) + px(childStyle.marginRight);
  }
  return width + px(style.columnGap) * Math.max(0, items - 1);
}

function px(value: string): number {
  return Number.parseFloat(value) || 0;
}
