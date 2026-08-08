/**
 * Size of the application chrome — toolbar, panes, cards, menus — as a
 * percentage. Separate from the document's own text size, which is a
 * reading setting rather than an interface one.
 *
 * Radix Themes sizes every space, font-size and line-height token off a
 * single `--scaling` multiplier. Its `scaling` prop only exposes 90–110%,
 * so app.css re-points that multiplier at `--ui-scale` instead, set here
 * on the document root. Setting it there rather than on the theme root is
 * what carries it into portalled surfaces — menus, popovers, dialogs —
 * which mount their own copy of the theme outside the React tree.
 */

const UI_SCALE_KEY = 'marginalia.uiScale';

export const UI_SCALE_MIN = 90;
export const UI_SCALE_MAX = 150;

/**
 * A tablet renders CSS pixels at roughly 1.5x the density of a desktop
 * monitor, so chrome authored for a desktop arrives physically small on
 * one — small enough to be hard to read and hard to hit. Nudge it up
 * where the pointer says we are on a touch screen.
 */
function deviceDefault(): number {
  return window.matchMedia?.('(pointer: coarse)').matches ? 115 : 100;
}

/**
 * Only an explicit choice is stored, so an untouched preference stays
 * free to follow the device.
 */
export function readUiScale(): number {
  const saved = Number(localStorage.getItem(UI_SCALE_KEY));
  const stored = Number.isFinite(saved) && saved >= UI_SCALE_MIN && saved <= UI_SCALE_MAX;
  return stored ? saved : deviceDefault();
}

export function applyUiScale(percent: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(percent / 100));
}

export function setUiScale(percent: number): void {
  localStorage.setItem(UI_SCALE_KEY, String(percent));
  applyUiScale(percent);
}
