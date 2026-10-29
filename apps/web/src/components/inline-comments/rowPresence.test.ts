/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { nextPresence, type PresenceRow, settlePresence, staticRows } from './rowPresence.js';

const DURATION = 100;
const item = (id: string) => ({ id });
const items = (...ids: string[]) => ids.map(item);

function next(
  prev: readonly PresenceRow<{ id: string }>[],
  ids: string[],
  over: Partial<Parameters<typeof nextPresence>[0]> = {},
) {
  return nextPresence({
    prev,
    items: items(...ids),
    now: 1000,
    duration: DURATION,
    animate: true,
    maxAnimated: 4,
    ...over,
  });
}

const shape = (rows: readonly PresenceRow<unknown>[]) =>
  rows.map((row) => (row.phase ? `${row.key}:${row.phase}` : row.key));

describe('nextPresence', () => {
  test('a leaving row stays where it was, behind the row it followed', () => {
    const rows = next(staticRows(items('a', 'b', 'c')), ['a', 'c']);
    expect(shape(rows)).toEqual(['a', 'b:exit', 'c']);
    expect(rows[1]?.until).toBe(1000 + DURATION);
  });

  test('a leaving first row stays at the top', () => {
    expect(shape(next(staticRows(items('a', 'b')), ['b']))).toEqual(['a:exit', 'b']);
  });

  test('neighbours leaving together keep their order', () => {
    expect(shape(next(staticRows(items('a', 'b', 'c', 'd')), ['a', 'd']))).toEqual([
      'a',
      'b:exit',
      'c:exit',
      'd',
    ]);
  });

  test('an arrival is marked to enter', () => {
    expect(shape(next(staticRows(items('a', 'c')), ['a', 'b', 'c']))).toEqual([
      'a',
      'b:enter',
      'c',
    ]);
  });

  test('a row leaving earlier keeps its deadline through an unrelated update', () => {
    const first = next(staticRows(items('a', 'b', 'c')), ['a', 'c']);
    const second = next(first, ['a', 'c'], { now: 1050 });
    expect(shape(second)).toEqual(['a', 'b:exit', 'c']);
    expect(second[1]?.until).toBe(1000 + DURATION);
  });

  test('a leaving row whose time is up is dropped by the next update', () => {
    const first = next(staticRows(items('a', 'b', 'c')), ['a', 'c']);
    expect(shape(next(first, ['a', 'c'], { now: 1000 + DURATION }))).toEqual(['a', 'c']);
  });

  test('an arrival keeps its deadline while it grows', () => {
    const first = next(staticRows(items('a')), ['a', 'b']);
    const second = next(first, ['a', 'b'], { now: 1050 });
    expect(shape(second)).toEqual(['a', 'b:enter']);
    expect(second[1]?.until).toBe(1000 + DURATION);
  });

  test('a leaving row that comes back grows in again', () => {
    const first = next(staticRows(items('a', 'b')), ['a']);
    expect(shape(next(first, ['a', 'b'], { now: 1050 }))).toEqual(['a', 'b:enter']);
  });

  test('a bulk change swaps the list without animating', () => {
    const rows = next(staticRows(items('a', 'b', 'c')), ['d', 'e', 'f']);
    expect(shape(rows)).toEqual(['d', 'e', 'f']);
  });

  test('a wholesale change swaps the list without animating', () => {
    expect(shape(next(staticRows(items('a', 'b')), ['a', 'c'], { animate: false }))).toEqual([
      'a',
      'c',
    ]);
  });

  test('the instant row appears at full height', () => {
    expect(shape(next(staticRows(items('a')), ['a', 'b'], { instantKey: 'b' }))).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('settlePresence', () => {
  test('drops finished exits and unmarks finished arrivals', () => {
    const rows = next(staticRows(items('a', 'b')), ['b', 'c']);
    expect(shape(rows)).toEqual(['a:exit', 'b', 'c:enter']);
    expect(shape(settlePresence(rows, 1000 + DURATION))).toEqual(['b', 'c']);
  });

  test('returns the same rows while animations still run', () => {
    const rows = next(staticRows(items('a', 'b')), ['b']);
    expect(settlePresence(rows, 1050)).toBe(rows);
  });
});
