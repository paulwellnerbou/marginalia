import { describe, expect, test } from 'bun:test';
import type { BlockInfo } from '@marginalia/renderer/types';
import { reanchor } from '../src/anchoring.js';
import type { CommentRow } from '../src/db.js';

/**
 * `reanchor` unit tests. The end-to-end save path is covered in
 * comments.test.ts; these drive the matcher directly so a block map can
 * be shaped to the ambiguous cases that only show up in long documents.
 */

interface BlockSpec {
  id: string;
  text: string;
  headingPath?: string[];
  sectionIndexPath?: number[];
}

function blockMap(specs: BlockSpec[]): BlockInfo[] {
  return specs.map((s, i) => {
    const headingPath = s.headingPath ?? [];
    const sectionIndexPath = s.sectionIndexPath ?? [i, ...headingPath.map(() => i)];
    return {
      id: s.id,
      kind: 'paragraph',
      text: s.text,
      headingPath,
      sectionIndex: sectionIndexPath[sectionIndexPath.length - 1]!,
      sectionIndexPath,
    };
  });
}

function comment(anchor: Partial<CommentRow>): CommentRow {
  return {
    id: 'c1',
    doc_uid: 'd1',
    parent_id: null,
    parent_proposal_id: null,
    anchor_block_id: null,
    anchor_end_block_id: null,
    anchor_quote: null,
    anchor_prefix: null,
    anchor_suffix: null,
    anchor_start_offset: null,
    anchor_end_offset: null,
    anchor_heading_path: null,
    anchor_section_index: null,
    anchor_section_index_path: null,
    author_client_id: 'client',
    author_display_name: 'Author',
    body: 'body',
    link_status: 'linked',
    resolved_at: null,
    resolved_by_name: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    ...anchor,
  };
}

describe('reanchor: short quotes', () => {
  test('an unchanged block keeps its anchor linked', () => {
    const blocks = blockMap([{ id: 'b1', text: 'The quick brown fox jumps over it.' }]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'b1',
        anchor_quote: 'brown fox',
        anchor_prefix: 'The quick ',
        anchor_suffix: ' jumps over it.',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.blockId).toBe('b1');
    expect(upd.startOffset).toBe(10);
  });

  test('a repeated short quote resolves by stored context, not first hit', () => {
    const blocks = blockMap([
      { id: 'b1', text: 'It waits, it settles, and then it climbs into the trees.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'b1',
        anchor_quote: 'it',
        anchor_prefix: 'settles, and then ',
        anchor_suffix: ' climbs into the trees.',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.startOffset).toBe(31);
  });

  test('a word-sized quote never re-anchors inside a longer word', () => {
    // "it" survives only inside "its" and "fits" — neither is the word
    // that was commented on.
    const blocks = blockMap([
      { id: 'b1', text: 'The comb finishes its circle and everything else fits around that.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'b1',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' climbs into the trees.',
      }),
      blocks,
    );
    expect(upd.linkStatus).not.toBe('linked');
    expect(upd.startOffset).not.toBe(18);
  });

  test('an ambiguous short quote with no surviving context orphans rather than guessing', () => {
    const blocks = blockMap([
      { id: 'b1', text: 'Something else entirely now.' },
      { id: 'b2', text: 'And it goes on.' },
      { id: 'b3', text: 'But it goes on.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'gone',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' climbs into the trees.',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('orphaned');
    expect(upd.blockId).toBeNull();
  });

  test('a stale block id does not survive a tie when its stored context agrees nowhere', () => {
    const blocks = blockMap([
      { id: 'b1', text: 'And it goes on.' },
      { id: 'b2', text: 'But it goes on.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'b1',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' climbs into the trees.',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('orphaned');
  });

  test('a block id survives a tie when there was no context to test it against', () => {
    const blocks = blockMap([
      { id: 'b1', text: 'And it goes on, it does.' },
      { id: 'b2', text: 'But it goes on.' },
    ]);
    const upd = reanchor(comment({ anchor_block_id: 'b1', anchor_quote: 'it' }), blocks);
    expect(upd.linkStatus).toBe('low-confidence');
    expect(upd.blockId).toBe('b1');
  });

  test('a distinctive quote that moved is still followed', () => {
    const blocks = blockMap([
      { id: 'b1', text: 'A different sentence now.' },
      { id: 'b2', text: 'But the brown fox still lives.' },
    ]);
    const upd = reanchor(comment({ anchor_block_id: 'gone', anchor_quote: 'brown fox' }), blocks);
    expect(upd.linkStatus).toBe('low-confidence');
    expect(upd.blockId).toBe('b2');
  });
});

describe('reanchor: heading-path affinity', () => {
  const AMBIGUOUS = blockMap([
    {
      id: 'ch1',
      text: 'He answers it before the question lands.',
      headingPath: ['Book', 'Chapter 1', 'Elias'],
      sectionIndexPath: [17, 17, 16, 15],
    },
    {
      id: 'ch4',
      text: 'He takes the mare uphill, and it climbs into the trees.',
      headingPath: ['Book', 'Chapter 4', 'Elias'],
      sectionIndexPath: [61, 61, 20, 15],
    },
  ]);

  test('legacy paths carrying the injected "#" sigil still score', () => {
    const upd = reanchor(
      comment({
        anchor_block_id: 'gone',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' rises',
        anchor_heading_path: JSON.stringify(['#Book', '#Chapter 4', '#Elias']),
        anchor_section_index_path: JSON.stringify([61, 61, 20, 15]),
      }),
      AMBIGUOUS,
    );
    expect(upd.blockId).toBe('ch4');
  });

  test('paths captured without their outer headings still score', () => {
    const upd = reanchor(
      comment({
        anchor_block_id: 'gone',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' rises',
        anchor_heading_path: JSON.stringify(['Chapter 4', 'Elias']),
        anchor_section_index_path: JSON.stringify([20, 15]),
      }),
      AMBIGUOUS,
    );
    expect(upd.blockId).toBe('ch4');
  });

  test('a stale block id no longer outranks the section the comment was written in', () => {
    // The id points at a Chapter 1 block that happens to contain the quote
    // — the state a drifted anchor gets persisted in.
    const upd = reanchor(
      comment({
        anchor_block_id: 'ch1',
        anchor_quote: 'it',
        anchor_prefix: 'up along the fence where ',
        anchor_suffix: ' climbs into the trees.',
        anchor_heading_path: JSON.stringify(['#Chapter 4', '#Elias']),
        anchor_section_index_path: JSON.stringify([61, 20, 15]),
      }),
      AMBIGUOUS,
    );
    expect(upd.linkStatus).toBe('low-confidence');
    expect(upd.blockId).toBe('ch4');
  });
});
