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
  /** Defaults true — the elementless case is exercised explicitly. */
  anchorable?: boolean;
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
      anchorable: s.anchorable ?? true,
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

describe('reanchor: blocks with no element', () => {
  // Raw HTML, YAML frontmatter, mermaid fences and unreferenced footnote
  // definitions all reach the block map with real text but no `data-block`
  // element in the rendered HTML. They are still in the map because edit
  // proposals resolve ids against the *source*, where they place fine —
  // but a comment anchored to one resolves to nothing in the browser.
  test('a quote found only in an elementless block orphans rather than pointing at it', () => {
    const upd = reanchor(
      comment({ anchor_block_id: null, anchor_quote: 'data-role="banner"' }),
      blockMap([
        { id: 'p1', text: 'Ordinary prose about layout.' },
        { id: 'rawhtml', text: '<div data-role="banner">Hi</div>', anchorable: false },
      ]),
    );
    expect(upd.linkStatus).toBe('orphaned');
    expect(upd.blockId).toBeNull();
  });

  test('an anchor already stored against one is not renewed', () => {
    // The state the bug persisted comments in: `anchor_block_id` names a
    // block whose text still holds the quote, so the id looks healthy and
    // survives every re-anchoring pass — while the client resolves it to
    // nothing and the highlight never appears.
    const upd = reanchor(
      comment({
        anchor_block_id: 'frontmatter',
        anchor_quote: 'Design Notes',
        anchor_prefix: 'title: ',
      }),
      blockMap([
        { id: 'frontmatter', text: 'title: Design Notes', anchorable: false },
        { id: 'p1', text: 'Unrelated prose.' },
      ]),
    );
    expect(upd.blockId).not.toBe('frontmatter');
    expect(upd.linkStatus).toBe('orphaned');
  });

  test('the same quote in a real block wins instead of tying with the elementless one', () => {
    const upd = reanchor(
      comment({ anchor_block_id: null, anchor_quote: 'const timeout = 30' }),
      blockMap([
        { id: 'mermaid', text: 'const timeout = 30', anchorable: false },
        { id: 'code', text: 'const timeout = 30' },
      ]),
    );
    // With both ranked there is no way to separate them and the ladder
    // orphans; with only the resolvable one left it is unambiguous.
    expect(upd.blockId).toBe('code');
    expect(upd.linkStatus).toBe('low-confidence');
  });

  test('an elementless block does not displace a linked anchor', () => {
    const upd = reanchor(
      comment({
        anchor_block_id: 'p1',
        anchor_quote: 'the retry budget',
        anchor_prefix: 'we should raise ',
        anchor_suffix: ' before launch.',
      }),
      blockMap([
        { id: 'raw', text: 'we should raise the retry budget before launch.', anchorable: false },
        { id: 'p1', text: 'we should raise the retry budget before launch.' },
      ]),
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.blockId).toBe('p1');
  });
});

describe('reanchor: edit proposals against elementless blocks', () => {
  test('keep their anchor — acceptance splices source, which resolves fine', () => {
    // A proposal rewriting a frontmatter field or a raw HTML block is
    // applicable: `locateAllBlocks` places both in the source. Orphaning
    // it for want of a `data-block` element would make it undiffable and
    // unacceptable, so the filter that protects comments skips proposals.
    const upd = reanchor(
      comment({
        anchor_block_id: 'frontmatter',
        anchor_quote: 'title: Design Notes',
        link_status: 'linked',
      }),
      blockMap([
        { id: 'frontmatter', text: 'title: Design Notes', anchorable: false },
        { id: 'p1', text: 'Unrelated prose.' },
      ]),
      { isEditProposal: true },
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.blockId).toBe('frontmatter');
  });
});
