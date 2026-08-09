/**
 * Where a display stepper lands, given where it is and what was pressed.
 *
 * Its own module so the arithmetic can be tested without a DOM: the
 * snapping in particular has to hold for values that predate the steps.
 */

export interface StepRange {
  min: number;
  max: number;
  step: number;
}

/** Steps a Page key covers at once. */
const LEAP = 5;

function clamp(value: number, { min, max }: StepRange): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * One step, snapped onto the grid `min` lays out.
 *
 * Rounding towards the direction of travel rather than to the nearest
 * grid point is what keeps a value the old sliders left off-grid from
 * carrying its offset forever, while still always moving the way the
 * user pressed — even where the snap alone would overshoot the step.
 */
export function stepValue(value: number, direction: 1 | -1, range: StepRange): number {
  const units = (value - range.min) / range.step;
  const grid = direction > 0 ? Math.floor(units) + 1 : Math.ceil(units) - 1;
  return clamp(range.min + grid * range.step, range);
}

/** Where a key press lands, or null where the key isn't the stepper's. */
export function stepForKey(key: string, value: number, range: StepRange): number | null {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return stepValue(value, 1, range);
    case 'ArrowDown':
    case 'ArrowLeft':
      return stepValue(value, -1, range);
    case 'PageUp':
      return clamp(value + range.step * LEAP, range);
    case 'PageDown':
      return clamp(value - range.step * LEAP, range);
    case 'Home':
      return range.min;
    case 'End':
      return range.max;
    default:
      return null;
  }
}
