/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { docColorStyle, parseDocColors, rgbToHex, withDocColor } from './doc-colors.js';

test('parseDocColors keeps only #rrggbb per known mode and role', () => {
  expect(parseDocColors(null)).toEqual({});
  expect(parseDocColors('not json')).toEqual({});
  expect(
    parseDocColors(
      JSON.stringify({
        light: { bg: '#F6F5F1', fg: 'red' },
        dark: { fg: '#ddd' },
        sepia: { bg: '#ffffff' },
      }),
    ),
  ).toEqual({ light: { bg: '#f6f5f1' } });
});

test('withDocColor sets, clears and drops empty modes', () => {
  const one = withDocColor({}, 'light', 'bg', '#FFFFFF');
  expect(one).toEqual({ light: { bg: '#ffffff' } });
  const two = withDocColor(one, 'dark', 'fg', '#eeeeee');
  expect(two).toEqual({ light: { bg: '#ffffff' }, dark: { fg: '#eeeeee' } });
  expect(withDocColor(two, 'light', 'bg', null)).toEqual({ dark: { fg: '#eeeeee' } });
  expect(one).toEqual({ light: { bg: '#ffffff' } });
});

test('docColorStyle maps overrides onto the theme variables', () => {
  expect(docColorStyle({})).toBeUndefined();
  expect(docColorStyle({ bg: '#fafafa' }) as Record<string, string>).toEqual({
    '--md-color-bg': '#fafafa',
  });
  expect(docColorStyle({ bg: '#fafafa', fg: '#111111' }) as Record<string, string>).toEqual({
    '--md-color-bg': '#fafafa',
    '--md-color-fg': '#111111',
  });
});

test('rgbToHex reads computed colors and rejects transparency', () => {
  expect(rgbToHex('rgb(246, 245, 241)')).toBe('#f6f5f1');
  expect(rgbToHex('rgba(0, 0, 0, 1)')).toBe('#000000');
  expect(rgbToHex('rgba(0, 0, 0, 0)')).toBeNull();
  expect(rgbToHex('rgb(0 0 0 / 50%)')).toBeNull();
  expect(rgbToHex('transparent')).toBeNull();
});
