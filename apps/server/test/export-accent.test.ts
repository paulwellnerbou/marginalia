import { describe, expect, test } from 'bun:test';
import { accentOverrideCss, exportAccent } from '../src/export/accent-css.js';

describe('exportAccent', () => {
  test("'none' is the theme's own, even over a document default", () => {
    expect(exportAccent('none', '#d6ec4e')).toBeNull();
  });
  test('a hex is the reader’s pick', () => {
    expect(exportAccent('#FF0000', '#d6ec4e')).toBe('#ff0000');
  });
  test('nothing, or anything unreadable, is the document default', () => {
    expect(exportAccent(undefined, '#d6ec4e')).toBe('#d6ec4e');
    expect(exportAccent('red', '#d6ec4e')).toBe('#d6ec4e');
    expect(exportAccent(undefined, null)).toBeNull();
  });
});

describe('accentOverrideCss', () => {
  test('nothing without an accent', () => {
    expect(accentOverrideCss(null)).toBe('');
  });
  test('the light shades, on the theme’s own selectors', () => {
    const css = accentOverrideCss('#ff0000');
    expect(css).toContain('.marginalia-theme, .marginalia {');
    expect(css).toContain('--md-color-accent: #bc0000;');
    expect(css).toContain('--md-color-accent-bright:');
    expect(css).toContain('--md-color-ornament:');
  });
});
