/**
 * Below this much overflow a row counts as fitting: the available width
 * is a rounded integer and the controls measure in fractions, and half a
 * pixel is not worth folding a control away for.
 */
const FIT_TOLERANCE_PX = 0.5;

/**
 * One step towards the stage at which a toolbar fits. Stage 0 is the
 * full bar and each later stage is narrower, up to `lastStage`.
 *
 * `needed[s]` is the width stage `s` took when it was last laid out. A
 * folded stage cannot measure the controls it has put away, so unfolding
 * goes by what the wider stage needed when it was on screen. Folding and
 * unfolding compare against the same number, so a row can't flip back
 * and forth at one width.
 */
export function nextFitStage(
  stage: number,
  needed: readonly (number | undefined)[],
  available: number,
  lastStage: number,
): number {
  const need = needed[stage];
  if (stage < lastStage && need !== undefined && need > available + FIT_TOLERANCE_PX) {
    return stage + 1;
  }
  const wider = needed[stage - 1];
  if (stage > 0 && wider !== undefined && wider <= available + FIT_TOLERANCE_PX) {
    return stage - 1;
  }
  return stage;
}
