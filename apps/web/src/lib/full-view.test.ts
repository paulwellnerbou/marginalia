import { describe, expect, test } from 'bun:test';
import { isFullViewSearch, linkWithFullView, withFullView } from './full-view.js';

describe('full view parameter', () => {
  test('is read from the query string', () => {
    expect(isFullViewSearch('?view=full')).toBe(true);
    expect(isFullViewSearch('?a=1&view=full')).toBe(true);
    expect(isFullViewSearch('')).toBe(false);
    expect(isFullViewSearch('?view=other')).toBe(false);
  });

  test('switching on keeps other parameters', () => {
    expect(withFullView('', true)).toBe('?view=full');
    expect(withFullView('?a=1', true)).toBe('?a=1&view=full');
    expect(withFullView('?view=full', true)).toBe('?view=full');
  });

  test('switching off removes only the full view value', () => {
    expect(withFullView('?view=full', false)).toBe('');
    expect(withFullView('?a=1&view=full', false)).toBe('?a=1');
    expect(withFullView('?view=other', false)).toBe('?view=other');
  });

  test('a share link carries it after the token', () => {
    const link = 'https://example.org/d/abc/tok';
    expect(linkWithFullView(link, true)).toBe('https://example.org/d/abc/tok?view=full');
    expect(linkWithFullView(link, false)).toBe(link);
    expect(linkWithFullView(`${link}?view=full`, false)).toBe(link);
  });
});
