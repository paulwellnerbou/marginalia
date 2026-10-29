import { memo, type ReactNode, useEffect, useState } from 'react';
import {
  nextPresence,
  type PresencePhase,
  type PresenceRow,
  settlePresence,
  staticRows,
} from './rowPresence.js';

/** Matches the `ic-list-row-enter` / `-exit` keyframes in app.css. */
export const ROW_PRESENCE_MS = 280;

/** See `maxAnimated` in rowPresence.ts. */
const MAX_ANIMATED_ROWS = 4;

export interface RowPresenceOptions {
  /**
   * Change this, in the same render as the list, to swap the list without
   * animating — see `animate` in rowPresence.ts.
   */
  resetToken: unknown;
  instantKey?: string | null;
}

/**
 * Keep rows that left `items` rendered until their exit animation has run,
 * and mark arrivals while theirs runs.
 *
 * Derived during render rather than in an effect: a leaving row has to stay
 * in the very commit that drops it from `items`, or React unmounts its card
 * and the ghost would be a fresh mount with none of the card's state.
 */
export function useRowPresence<T extends { id: string }>(
  items: readonly T[],
  { resetToken, instantKey = null }: RowPresenceOptions,
): readonly PresenceRow<T>[] {
  const [state, setState] = useState(() => ({
    items,
    resetToken,
    rows: staticRows(items) as readonly PresenceRow<T>[],
  }));

  let rows = state.rows;
  if (state.items !== items || state.resetToken !== resetToken) {
    rows = nextPresence({
      prev: state.rows,
      items,
      now: performance.now(),
      duration: ROW_PRESENCE_MS,
      animate: state.resetToken === resetToken && !prefersReducedMotion(),
      maxAnimated: MAX_ANIMATED_ROWS,
      instantKey,
    });
    setState({ items, resetToken, rows });
  }

  // A timer, not `animationend`: a hidden tab or a frozen compositor never
  // finishes the animation, and a ghost must not outstay it.
  useEffect(() => {
    let next = Number.POSITIVE_INFINITY;
    for (const row of rows) if (row.phase !== null) next = Math.min(next, row.until);
    if (next === Number.POSITIVE_INFINITY) return;
    const timer = window.setTimeout(
      () =>
        setState((s) => {
          const settled = settlePresence(s.rows, performance.now());
          return settled === s.rows ? s : { ...s, rows: settled };
        }),
      Math.max(0, next - performance.now()) + 16,
    );
    return () => window.clearTimeout(timer);
  }, [rows]);

  return rows;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The wrapper a presence row animates. The clip sits around `children`, so
 * whatever is measured inside keeps its full height throughout.
 */
export function PresenceRowFrame({
  phase,
  children,
}: {
  phase: PresencePhase;
  children: ReactNode;
}) {
  return (
    <div className="ic-list-presence" data-presence={phase ?? undefined} inert={phase === 'exit'}>
      <div className="ic-list-presence-clip">
        <FreezeWhileLeaving leaving={phase === 'exit'}>{children}</FreezeWhileLeaving>
      </div>
    </div>
  );
}

/**
 * Holds a leaving row's last rendering. The thread behind it may already be
 * deleted or filtered away, and re-rendering it from what is left — an
 * expanded card whose collapse entry went with the thread, a resolved badge
 * — would change its height mid-animation.
 */
const FreezeWhileLeaving = memo(
  function FreezeWhileLeaving({ children }: { children: ReactNode; leaving: boolean }) {
    return children;
  },
  (_prev, next) => next.leaving,
);
