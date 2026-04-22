/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { EditProposal } from '../lib/api.js';
import { resolveProposalDiffBefore } from './proposalDiff.js';

const baseProposal: EditProposal = {
  id: 'proposal-1',
  comment: {
    id: 'proposal-1',
    parent_id: null,
    parent_proposal_id: null,
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
    author: {
      client_id: 'client-1',
      display_name: 'Alice',
    },
    body: '',
    link_status: 'linked',
    resolved_at: null,
    resolved_by_name: null,
    created_at: 1,
    updated_at: 1,
  },
  anchor_kind: null,
  source_snapshot: '[5.3](#53-hosting--betrieb)',
  proposed_text: '[5.3](#53-hosting-betrieb)',
  status: 'open',
  decided_at: null,
  decided_by_name: null,
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
  const before = resolveProposalDiffBefore({
    proposal: { ...baseProposal, status: 'accepted' },
    docSource: source,
    blockRanges: makeBlockRanges(source),
  });

  expect(before).toBe('[5.3](#53-hosting--betrieb)');
});

test('uses the live block source for open proposals while the document still differs', () => {
  const source = '5.3';
  const before = resolveProposalDiffBefore({
    proposal: baseProposal,
    docSource: source,
    blockRanges: makeBlockRanges(source),
  });

  expect(before).toBe('5.3');
});

test('falls back to the saved snapshot when the live block already matches the proposal', () => {
  const source = '[5.3](#53-hosting-betrieb)';
  const before = resolveProposalDiffBefore({
    proposal: baseProposal,
    docSource: source,
    blockRanges: makeBlockRanges(source),
  });

  expect(before).toBe('[5.3](#53-hosting--betrieb)');
});
