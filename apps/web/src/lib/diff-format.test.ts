/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { formatUnifiedDiff } from './diff-format.js';

test('formats a mixed diff as a single full-context hunk', () => {
  const text = formatUnifiedDiff([
    { op: 'equal', text: 'alpha' },
    { op: 'remove', text: 'beta' },
    { op: 'add', text: 'gamma' },
    { op: 'equal', text: '' },
  ]);

  expect(text).toBe(
    ['--- before', '+++ after', '@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' '].join('\n'),
  );
});

test('starts a side with no lines at 0, as diff -u does', () => {
  const added = formatUnifiedDiff([
    { op: 'add', text: 'alpha' },
    { op: 'add', text: 'beta' },
  ]);
  expect(added).toContain('@@ -0,0 +1,2 @@');

  const removed = formatUnifiedDiff([
    { op: 'remove', text: 'alpha' },
    { op: 'remove', text: 'beta' },
  ]);
  expect(removed).toContain('@@ -1,2 +0,0 @@');
});

test('counts pure insertions only on the new side', () => {
  const text = formatUnifiedDiff([
    { op: 'equal', text: 'one' },
    { op: 'add', text: 'two' },
  ]);

  expect(text).toContain('@@ -1,1 +1,2 @@');
});
