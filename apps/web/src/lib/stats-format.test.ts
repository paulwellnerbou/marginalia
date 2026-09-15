import { describe, expect, test } from 'bun:test';
import { formatPages, formatReadingTime, formatShare } from './stats-format.js';

describe('formatPages', () => {
  test('shows one decimal below ten pages and whole pages above', () => {
    expect(formatPages(0, 250, 'en-US')).toBe('0');
    expect(formatPages(3, 250, 'en-US')).toBe('< 0.1');
    expect(formatPages(100, 250, 'en-US')).toBe('0.4');
    expect(formatPages(2375, 250, 'en-US')).toBe('9.5');
    expect(formatPages(80_000, 250, 'en-US')).toBe('320');
    expect(formatPages(80_000, 300, 'en-US')).toBe('267');
  });
});

describe('formatReadingTime', () => {
  test('rounds to minutes and rolls over into hours', () => {
    expect(formatReadingTime(0, 240)).toBe('0 min');
    expect(formatReadingTime(100, 240)).toBe('< 1 min');
    expect(formatReadingTime(2_900, 240)).toBe('12 min');
    expect(formatReadingTime(14_400, 240)).toBe('1 h');
    expect(formatReadingTime(15_600, 240)).toBe('1 h 5 min');
    expect(formatReadingTime(14_300, 240)).toBe('1 h');
  });
});

describe('formatShare', () => {
  test('rounds to whole percent, with a floor for slivers', () => {
    expect(formatShare(0, 100)).toBe('0%');
    expect(formatShare(1, 1000)).toBe('< 1%');
    expect(formatShare(1, 100)).toBe('1%');
    expect(formatShare(250, 1000)).toBe('25%');
    expect(formatShare(5, 0)).toBe('0%');
  });
});
