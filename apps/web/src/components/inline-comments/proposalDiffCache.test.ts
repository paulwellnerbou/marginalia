/// <reference types="bun" />

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  proposalDiffNeedsRefresh,
  readCachedProposalDiff,
  resetProposalDiffCache,
  writeCachedProposalDiff,
} from './proposalDiffCache.js';

test('refreshes the diff when an open proposal is edited', () => {
  expect(proposalDiffNeedsRefresh('open', 'old proposal', 'revised proposal')).toBe(true);
});

test('keeps the visible diff when an accepted proposal omits its closed text', () => {
  expect(proposalDiffNeedsRefresh('accepted', 'accepted proposal', null)).toBe(false);
});

test('keeps the visible diff when a rejected proposal omits its closed text', () => {
  expect(proposalDiffNeedsRefresh('rejected', 'rejected proposal', null)).toBe(false);
});

describe('the diff cache across a card unmounting', () => {
  const DIFF = { before: 'a', after: 'b', original: null, mergeable: 'clean' } as never;
  const OTHER = { before: 'x', after: 'y', original: null, mergeable: 'clean' } as never;

  beforeEach(() => {
    resetProposalDiffCache();
  });

  test('serves a diff fetched before the card was destroyed', () => {
    writeCachedProposalDiff('doc', 't1', 'proposed text', DIFF);

    expect(readCachedProposalDiff('doc', 't1', 'open', 'proposed text')).toBe(DIFF);
  });

  test('re-reads when an open proposal has been edited since', () => {
    writeCachedProposalDiff('doc', 't1', 'first text', DIFF);

    expect(readCachedProposalDiff('doc', 't1', 'open', 'second text')).toBeNull();
  });

  test('keeps serving a closed proposal whose text is no longer sent', () => {
    // Accepting drops `proposed_text` to null. That is the payload
    // changing shape, not the proposal changing, and evicting there would
    // refetch a diff the dialog is about to stop showing.
    writeCachedProposalDiff('doc', 't1', 'proposed text', DIFF);

    expect(readCachedProposalDiff('doc', 't1', 'accepted', null)).toBe(DIFF);
  });

  test('keeps proposals and documents apart', () => {
    writeCachedProposalDiff('doc', 't1', 'text', DIFF);
    writeCachedProposalDiff('doc', 't2', 'text', OTHER);

    expect(readCachedProposalDiff('doc', 't2', 'open', 'text')).toBe(OTHER);
    expect(readCachedProposalDiff('other-doc', 't1', 'open', 'text')).toBeNull();
  });

  test('bounds itself, evicting what was read longest ago', () => {
    writeCachedProposalDiff('doc', 'keep', 'text', DIFF);
    for (let i = 0; i < 40; i++) writeCachedProposalDiff('doc', `t${i}`, 'text', OTHER);

    expect(readCachedProposalDiff('doc', 'keep', 'open', 'text')).toBeNull();
    expect(readCachedProposalDiff('doc', 't39', 'open', 'text')).toBe(OTHER);
  });
});
