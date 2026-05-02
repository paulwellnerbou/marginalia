/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { Thread } from '../lib/api.js';
import { resolveProposalDiffBefore } from './proposalDiff.js';

const baseThread: Thread & { proposal: NonNullable<Thread['proposal']> } = {
  id: 'proposal-1',
  state: 'open',
  resolution: null,
  link_status: 'linked',
  anchor: {
    block_id: 'block-1',
    quote: '5.3',
    prefix: '',
    suffix: '',
    start_offset: 0,
    end_offset: 3,
    heading_path: null,
    section_index: null,
    section_index_path: null,
  },
  capabilities: { reply: true, resolve: true, accept: false, reject: false, reopen: false },
  comments: [
    {
      id: 'proposal-1',
      body: '',
      author: { client_id: 'client-1', display_name: 'Alice' },
      capabilities: { edit: true, delete: true },
      created_at: 1,
      updated_at: 1,
    },
  ],
  proposal: {
    anchor_kind: null,
    source_snapshot: '[5.3](#53-hosting--betrieb)',
    proposed_text: '[5.3](#53-hosting-betrieb)',
  },
};

function makeBlockRanges(source: string): Map<string, BlockSourceRange> {
  return new Map([
    [
      'block-1',
      {
        start: 0,
        end: source.length,
        kind: 'paragraph',
        text: source,
      },
    ],
  ]);
}

test('uses the saved snapshot for accepted proposals so their diff remains visible', () => {
  const source = '[5.3](#53-hosting-betrieb)';
  const acceptedThread: typeof baseThread = {
    ...baseThread,
    state: 'resolved',
    resolution: { kind: 'accept', at: 2, by_name: 'Alice' },
  };
  const before = resolveProposalDiffBefore({
    thread: acceptedThread,
    docSource: source,
    blockRanges: makeBlockRanges(source),
    docFormat: 'markdown',
  });

  expect(before).toBe('[5.3](#53-hosting--betrieb)');
});

test('uses the live block source for open proposals while the document still differs', () => {
  const source = '5.3';
  const before = resolveProposalDiffBefore({
    thread: baseThread,
    docSource: source,
    blockRanges: makeBlockRanges(source),
    docFormat: 'markdown',
  });

  expect(before).toBe('5.3');
});

test('falls back to the saved snapshot when the live block already matches the proposal', () => {
  const source = '[5.3](#53-hosting-betrieb)';
  const before = resolveProposalDiffBefore({
    thread: baseThread,
    docSource: source,
    blockRanges: makeBlockRanges(source),
    docFormat: 'markdown',
  });

  expect(before).toBe('[5.3](#53-hosting--betrieb)');
});
