/**
 * A picked accent color turned into the shades a theme reads. One pick
 * serves both appearances: link text has to stay readable on the page,
 * so a light pick is darkened for a light page and a dark pick lifted
 * for a dark one, keeping its hue. Shades are taken in OKLCH, whose
 * lightness tracks perceived lightness across hues, so one threshold
 * holds for yellow and blue alike.
 */

export type AccentMode = 'light' | 'dark';

export interface AccentPalette {
  /** Link text and other accent text: readable on the page. */
  accent: string;
  /** Underlines and other quiet accent lines; translucent so any paper shows through. */
  muted: string;
  /** Bars, fills and markers, where the pick itself can be bright. */
  bright: string;
  /** Rules and ornaments: a mid tone, visible on paper without competing with text. */
  ornament: string;
}

const HEX = /^#[0-9a-f]{6}$/;

/** `#rrggbb` (lowercased), or null for anything else. */
export function normalizeAccent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return HEX.test(v) ? v : null;
}

/** OKLCH lightness bounds for accent text, ~4.5:1 or better on the themes' pages. */
const LIGHT_TEXT_MAX_L = 0.5;
const DARK_TEXT_MIN_L = 0.78;
/** A bar darker than this disappears on a dark page. */
const DARK_BRIGHT_MIN_L = 0.6;
/** Ornament lightness bounds: no lighter than the report theme's tan rule on a light page. */
const LIGHT_ORNAMENT_MAX_L = 0.72;
const DARK_ORNAMENT_MIN_L = 0.65;
/** 40% opacity. */
const MUTED_ALPHA = '66';

export function accentPalette(hex: string, mode: AccentMode): AccentPalette {
  const [l, c, h] = hexToOklch(hex);
  const textL = mode === 'light' ? Math.min(l, LIGHT_TEXT_MAX_L) : Math.max(l, DARK_TEXT_MIN_L);
  const accent = oklchToHex(textL, c, h);
  const bright =
    mode === 'light' ? hex.toLowerCase() : oklchToHex(Math.max(l, DARK_BRIGHT_MIN_L), c, h);
  const ornament = oklchToHex(
    mode === 'light' ? Math.min(l, LIGHT_ORNAMENT_MAX_L) : Math.max(l, DARK_ORNAMENT_MIN_L),
    c,
    h,
  );
  return { accent, muted: `${accent}${MUTED_ALPHA}`, bright, ornament };
}

/** The theme-contract custom properties for a picked accent (see THEMING.md). */
export function accentCssVars(hex: string, mode: AccentMode): Record<string, string> {
  const p = accentPalette(hex, mode);
  return {
    '--md-color-accent': p.accent,
    '--md-color-accent-muted': p.muted,
    '--md-color-accent-bright': p.bright,
    '--md-color-ornament': p.ornament,
  };
}

// --- OKLab (Björn Ottosson's matrices) ------------------------------

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function hexToOklch(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = toLinear(((n >> 16) & 255) / 255);
  const g = toLinear(((n >> 8) & 255) / 255);
  const b = toLinear((n & 255) / 255);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinearRgb(L: number, C: number, H: number): [number, number, number] {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const EPS = 1e-6;
function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= -EPS && v <= 1 + EPS);
}

/** Keeps lightness and hue; gives up chroma until the color fits sRGB. */
function oklchToHex(L: number, C: number, H: number): string {
  let rgb = oklchToLinearRgb(L, C, H);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb(L, mid, H))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb(L, lo, H);
  }
  return `#${rgb
    .map((v) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
