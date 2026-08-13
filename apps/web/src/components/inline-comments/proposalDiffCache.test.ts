/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { proposalDiffNeedsRefresh } from './proposalDiffCache.js';

test('refreshes the diff when an open proposal is edited', () => {
  expect(proposalDiffNeedsRefresh('open', 'old proposal', 'revised proposal')).toBe(true);
});

test('keeps the visible diff when an accepted proposal omits its closed text', () => {
  expect(proposalDiffNeedsRefresh('accepted', 'accepted proposal', null)).toBe(false);
});

test('keeps the visible diff when a rejected proposal omits its closed text', () => {
  expect(proposalDiffNeedsRefresh('rejected', 'rejected proposal', null)).toBe(false);
});
