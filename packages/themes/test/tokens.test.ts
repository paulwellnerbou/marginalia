import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  THEME_IDS,
  THEME_TOKENS,
  getThemeTokens,
  type ThemeTokens,
} from '../src/tokens.js';

const THEMES_DIR = dirname(fileURLToPath(import.meta.url));
const CSS_DIR = join(THEMES_DIR, '..', 'css');

// The web app's BUILT_IN_THEMES list (apps/web/src/lib/themes.ts). We
// hard-code the expected set here rather than import from the web
// package to keep this test's deps minimal. If the list grows, this
// test fails — intentional: every theme must have tokens.
const EXPECTED_IDS = [
  'default',
  'beautiful',
  'book',
  'article',
  'technical',
  'serif-print',
];

describe('theme tokens', () => {
  test('every built-in theme has tokens', () => {
    for (const id of EXPECTED_IDS) {
      expect(THEME_TOKENS[id], `missing tokens for theme '${id}'`).toBeDefined();
    }
    expect([...THEME_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  test.each(EXPECTED_IDS)('%s tokens are structurally complete', (id) => {
    const t = THEME_TOKENS[id]!;
    expect(t.id).toBe(id);
    expect(t.label.length).toBeGreaterThan(0);
    expect(t.fonts.body.families.length).toBeGreaterThan(0);
    expect(t.fonts.heading.families.length).toBeGreaterThan(0);
    expect(t.fonts.mono.families.length).toBeGreaterThan(0);
    expect(t.fontSize.basePt).toBeGreaterThan(6);
    expect(t.fontSize.basePt).toBeLessThan(40);
    for (const em of [t.fontSize.h1Em, t.fontSize.h2Em, t.fontSize.h3Em, t.fontSize.h4Em]) {
      expect(em).toBeGreaterThan(0.5);
      expect(em).toBeLessThan(5);
    }
    expect(t.lineHeight.body).toBeGreaterThan(0.8);
    expect(t.lineHeight.heading).toBeGreaterThan(0.8);
    expect(t.headingWeight).toBeGreaterThanOrEqual(100);
    expect(t.headingWeight).toBeLessThanOrEqual(900);
    // Every color is a 6-digit lowercase hex (keeps the exporter simple).
    for (const [key, value] of Object.entries(t.colors)) {
      expect(value, `color ${key} of theme '${id}'`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(t.spacing.blockEm).toBeGreaterThan(0);
    expect(t.spacing.headingTopEm).toBeGreaterThan(0);
    expect(t.spacing.listItemEm).toBeGreaterThanOrEqual(0);
    expect(['A4', 'Letter', 'A5', 'B5']).toContain(t.page.size);
    expect(t.page.marginPt).toBeGreaterThan(18); // sanity: at least 0.25in
  });

  test('getThemeTokens falls back to default on unknown id', () => {
    expect(getThemeTokens('does-not-exist').id).toBe('default');
    expect(getThemeTokens(null).id).toBe('default');
    expect(getThemeTokens(undefined).id).toBe('default');
    expect(getThemeTokens('beautiful').id).toBe('beautiful');
  });

  // Lightweight drift check: a handful of values that are easy to grep
  // for in the CSS. Not exhaustive — the goal is to catch "someone
  // changed the CSS and forgot to update tokens" for the most-looked-at
  // values (colors and font sizes). Structural unit mismatches (em vs
  // pt) would show up here as well.
  describe('CSS drift spot-checks', () => {
    function readCss(id: string): string {
      return readFileSync(join(CSS_DIR, `${id}.css`), 'utf8');
    }

    function expectCssContains(id: string, needle: string): void {
      const css = readCss(id);
      expect(css, `${id}.css should contain "${needle}"`).toContain(needle);
    }

    test('default palette and base size', () => {
      const t = THEME_TOKENS.default!;
      // basePt 12.75 ← 17px (pxPt conversion)
      expect(t.fontSize.basePt).toBeCloseTo(12.75, 3);
      expectCssContains('default', '--md-font-size: 17px');
      expectCssContains('default', t.colors.fg);
      expectCssContains('default', t.colors.accent);
    });

    test('beautiful uses Fraunces for headings', () => {
      const t = THEME_TOKENS.beautiful!;
      expect(t.fonts.heading.families[0]).toBe('Fraunces');
      expectCssContains('beautiful', 'Fraunces');
      expectCssContains('beautiful', t.colors.accent);
    });

    test('technical uses Inter body and JetBrains Mono', () => {
      const t = THEME_TOKENS.technical!;
      expect(t.fonts.body.families[0]).toBe('Inter');
      expect(t.fonts.mono.families[0]).toBe('JetBrains Mono');
      expectCssContains('technical', 'Inter');
      expectCssContains('technical', 'JetBrains Mono');
    });

    test('serif-print uses pt-based base size (12pt)', () => {
      const t = THEME_TOKENS['serif-print']!;
      expect(t.fontSize.basePt).toBe(12);
      expectCssContains('serif-print', '--md-font-size: 12pt');
    });
  });
});

// Type-level: ensure the interface is re-exported for consumers.
const _typeCheck: ThemeTokens = THEME_TOKENS.default!;
void _typeCheck;
