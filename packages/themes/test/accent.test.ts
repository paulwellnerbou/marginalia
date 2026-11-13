import { describe, expect, test } from 'bun:test';
import { accentCssVars, accentPalette, normalizeAccent } from '../src/accent.js';

/** Relative luminance, for WCAG contrast. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const REPORT_PAPER = '#f6f5f1';
const REPORT_INK = '#23221f';

/** `a` over `b` at `alpha`, in sRGB like the theme's color-mix. */
function mix(a: string, b: string, alpha: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(a, i) * alpha + ch(b, i) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const PICKS = [
  '#d6ec4e',
  '#ffcc00',
  '#ff0000',
  '#00ff00',
  '#2156a5',
  '#ffffff',
  '#000000',
  '#7f3fbf',
];

describe('normalizeAccent', () => {
  test('accepts #rrggbb, lowercased', () => {
    expect(normalizeAccent('#A1B2C3')).toBe('#a1b2c3');
  });
  test('rejects anything else', () => {
    for (const v of ['#abc', 'red', '#a1b2c3ff', '', null, 7])
      expect(normalizeAccent(v)).toBeNull();
  });
});

describe('accentPalette', () => {
  test('link text is readable on a light page', () => {
    for (const pick of PICKS) {
      expect(contrast(accentPalette(pick, 'light').accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('link text is readable on a dark page', () => {
    for (const pick of PICKS) {
      expect(contrast(accentPalette(pick, 'dark').accent, '#1b1b19')).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('a pick that is already readable is kept', () => {
    expect(accentPalette('#2156a5', 'light').accent).toBe('#2156a5');
    expect(accentPalette('#d6ec4e', 'dark').accent).toBe('#d6ec4e');
  });

  test("the report theme's own lime survives as the bright shade", () => {
    expect(accentPalette('#d6ec4e', 'light').bright).toBe('#d6ec4e');
  });

  test('selected text stays readable on the report selection (60% bright on paper)', () => {
    for (const pick of [...PICKS, '#1f3864']) {
      const selection = mix(accentPalette(pick, 'light').bright, REPORT_PAPER, 0.6);
      expect(contrast(REPORT_INK, selection)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('a pale pick still shows as a bar on light paper', () => {
    for (const pick of ['#fff4c2', '#ffffff', '#f0f0ff']) {
      expect(contrast(accentPalette(pick, 'light').bright, REPORT_PAPER)).toBeGreaterThan(1.15);
    }
  });

  test('a pale pick is deepened for rules on a light page, kept on a dark one', () => {
    expect(accentPalette('#d6ec4e', 'light').ornament).toBe('#9eb100');
    expect(accentPalette('#d6ec4e', 'dark').ornament).toBe('#d6ec4e');
    expect(accentPalette('#2156a5', 'light').ornament).toBe('#2156a5');
  });

  test('the muted shade is the text shade, translucent', () => {
    const p = accentPalette('#ff0000', 'light');
    expect(p.muted).toBe(`${p.accent}66`);
  });

  test('every shade is a hex color', () => {
    for (const pick of PICKS) {
      for (const mode of ['light', 'dark'] as const) {
        for (const v of Object.values(accentCssVars(pick, mode))) {
          expect(v).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
        }
      }
    }
  });
});
