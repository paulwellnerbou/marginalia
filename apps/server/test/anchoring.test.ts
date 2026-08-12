import { describe, expect, test } from 'bun:test';
import type { BlockInfo, BlockSourceRange } from '@marginalia/renderer';
import { prepareBlockReplacements, reanchor } from '../src/anchoring.js';
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
    is_hidden: 0,
    link_status: 'linked',
    resolved_at: null,
    resolved_by_name: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
    ...anchor,
  };
}

function sourceMap(specs: BlockSpec[]): Map<string, BlockSourceRange> {
  return new Map(
    specs.map((s, i) => [
      s.id,
      { start: i * 100, end: i * 100 + s.text.length, kind: 'paragraph', text: s.text },
    ]),
  );
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

  // The word a comment asks about is exactly the word an author edits, so
  // "jacket" becomes "jackets" and the quote survives only inside a longer
  // word. What is left of the neighbourhood is the filler every paragraph
  // has — " the " before a noun — and taking that as evidence lands the
  // comment several chapters away from anything it was about.
  const PLURALIZED = blockMap([
    {
      id: 'ch6',
      text: 'They go down onto the jackets together, skin along the whole length of skin.',
      headingPath: ['Book', 'Chapter 6', 'Maeve'],
      sectionIndexPath: [90, 90, 28, 12],
    },
    {
      id: 'ch4',
      text: 'He puts the coat on for the meadow rounds, because the jacket he rode in is sweat-damp.',
      headingPath: ['Book', 'Chapter 4', 'Elias'],
      sectionIndexPath: [40, 40, 42, 41],
    },
    {
      id: 'ch2',
      text: 'She waits by the gate, her hands drawn up inside her jacket sleeves.',
      headingPath: ['Book', 'Chapter 2', 'Elias'],
      sectionIndexPath: [20, 20, 10, 9],
    },
  ]);

  const PLURALIZED_ANCHOR = {
    anchor_quote: 'jacket',
    anchor_prefix: 'They go down onto the ',
    anchor_suffix: ' together, and the first full length of skin on skin in open sun',
  };

  test('filler left over from a rewritten neighbourhood is not evidence', () => {
    const upd = reanchor(comment({ anchor_block_id: 'gone', ...PLURALIZED_ANCHOR }), PLURALIZED);
    expect(upd.linkStatus).toBe('orphaned');
    expect(upd.blockId).toBeNull();
  });

  test('a guess is not promoted to linked on the next pass', () => {
    // The state an earlier bad match persists: the id points at the block it
    // guessed, where the same " the " still agrees. Believing it there is how
    // a guess stops being distinguishable from an anchor nobody doubted.
    const upd = reanchor(
      comment({ anchor_block_id: 'ch4', link_status: 'low-confidence', ...PLURALIZED_ANCHOR }),
      PLURALIZED,
    );
    expect(upd.linkStatus).not.toBe('linked');
  });

  test('a short context that survives intact still links', () => {
    // A quote against the edge of its block stores only the few chars that
    // fit. All of them agreeing is the most that anchor can ever offer, so
    // the bar for trusting it cannot be an absolute length.
    const blocks = blockMap([
      { id: 'b1', text: 'The cat sat.' },
      { id: 'b2', text: 'Everyone agrees the cat sat there, and nobody minds.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'b1',
        anchor_quote: 'cat sat',
        anchor_prefix: 'The ',
        anchor_suffix: '.',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.blockId).toBe('b1');
    expect(upd.startOffset).toBe(4);
  });

  test('an intact context window wins a tie against a partial one', () => {
    // `asAnchor` stores prefix/suffix as the client sent them, so a
    // whitespace-only window is storable even though the browser's own
    // capture reads them out of trimmed block text. Whitespace agreement
    // scores zero however much of it survives, so the intact occurrence ties
    // with the partial one and has to win that tie — losing it leaves the
    // block looking like it holds only a drifted match.
    const blocks = blockMap([
      { id: 'b1', text: 'it, and then it ' },
      { id: 'b2', text: 'But it, goes on.' },
    ]);
    const upd = reanchor(
      comment({ anchor_block_id: 'b1', anchor_quote: 'it', anchor_suffix: ' ' }),
      blocks,
    );
    expect(upd.linkStatus).toBe('linked');
    expect(upd.blockId).toBe('b1');
    expect(upd.startOffset).toBe(13);
  });

  test('dialogue boilerplate does not launder a stale says anchor as linked', () => {
    // Production regression CxaajFMvNRNlVHi1. The selected "says" was
    // removed from the Chapter 6 paragraph. A stale id pointed at the only
    // other occurrence preceded by the 12 raw characters `ing," Maeve `.
    // Counting punctuation and a partial word made that coincidence meet the
    // old STRONG_CONTEXT threshold and become permanently "linked".
    const blocks = blockMap([
      {
        id: 'wrong-chapter-3',
        text: '"We should know what we\'re doing," Maeve says to the sky. "Before somebody gets hurt."',
      },
      {
        id: 'right-chapter-6',
        text: '"He didn\'t say one useless thing." Maeve wipes her eyes. "He didn\'t ask a single question either."',
      },
      { id: 'other', text: '"Nothing changes," Maeve says, and closes the door.' },
    ]);
    const upd = reanchor(
      comment({
        anchor_block_id: 'wrong-chapter-3',
        anchor_quote: 'says',
        anchor_prefix: '"He didn\'t say one useless thing," Maeve ',
        anchor_suffix: ' at the end, wiping her eyes. "He didn\'t ask a single question e',
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('orphaned');
    expect(upd.blockId).toBeNull();
  });

  test('a paragraph rewrite plus adjacent deletion follows the replacement', () => {
    const before = [
      {
        id: 'wrong-chapter-3',
        text: '"We should know what we\'re doing," Maeve says to the sky.',
      },
      {
        id: 'old-chapter-6',
        text: '"He didn\'t say one useless thing," Maeve says at the end, wiping her eyes.',
      },
      { id: 'deleted', text: '"He meant it," Clara says.' },
      { id: 'stable-after', text: 'They hold each other until dinner.' },
    ];
    const after = [
      before[0]!,
      {
        id: 'new-chapter-6',
        text: '"He didn\'t say one useless thing." Maeve wipes her eyes.',
      },
      before[3]!,
    ];
    const anchor = comment({
      anchor_block_id: 'old-chapter-6',
      anchor_quote: 'says',
      anchor_prefix: '"He didn\'t say one useless thing," Maeve ',
      anchor_suffix: ' at the end, wiping her eyes.',
      anchor_start_offset: 41,
      anchor_end_offset: 45,
    });
    const upd = reanchor(anchor, blockMap(after), {
      blockReplacements: prepareBlockReplacements({
        before: sourceMap(before),
        after: sourceMap(after),
      }),
    });
    expect(upd).toMatchObject({
      linkStatus: 'low-confidence',
      blockId: 'new-chapter-6',
      startOffset: null,
      endOffset: null,
    });

    // The old quote stays available to explain the comment, but a later save
    // must not use it to launch another global search from this intentionally
    // block-only, low-confidence anchor.
    const nextPass = reanchor(
      comment({
        ...anchor,
        anchor_block_id: upd.blockId,
        anchor_start_offset: upd.startOffset,
        anchor_end_offset: upd.endOffset,
        link_status: upd.linkStatus,
      }),
      blockMap(after),
    );
    expect(nextPass).toMatchObject({
      linkStatus: 'low-confidence',
      blockId: 'new-chapter-6',
      startOffset: null,
      endOffset: null,
    });
  });

  test('a surviving repeated quote keeps its exact range in a rewritten block', () => {
    const before = [
      { id: 'stable-before', text: 'Before.' },
      { id: 'old', text: 'First brown fox. Second brown fox.' },
      { id: 'stable-after', text: 'After.' },
    ];
    const after = [
      before[0]!,
      { id: 'new', text: 'Added. First brown fox. Second brown fox.' },
      before[2]!,
    ];
    const upd = reanchor(
      comment({
        anchor_block_id: 'old',
        anchor_quote: 'brown fox',
        anchor_prefix: 'First brown fox. Second ',
        anchor_suffix: '.',
        anchor_start_offset: 24,
        anchor_end_offset: 33,
      }),
      blockMap(after),
      {
        blockReplacements: prepareBlockReplacements({
          before: sourceMap(before),
          after: sourceMap(after),
        }),
      },
    );
    expect(upd).toMatchObject({
      linkStatus: 'low-confidence',
      blockId: 'new',
      startOffset: 31,
      endOffset: 40,
    });
  });

  test('similarity does not choose between repeated rewrite candidates', () => {
    const before = [
      { id: 'stable-before', text: 'Before.' },
      { id: 'old-red', text: 'Maeve takes the red coat down from the hook.' },
      { id: 'old-blue', text: 'Maeve takes the blue coat down from the hook.' },
      { id: 'stable-after', text: 'After.' },
    ];
    const after = [
      before[0]!,
      { id: 'new-green', text: 'Maeve takes the green coat down from the hook.' },
      before[3]!,
    ];
    const upd = reanchor(
      comment({
        anchor_block_id: 'old-red',
        anchor_quote: 'red',
        anchor_prefix: 'Maeve takes the ',
        anchor_suffix: ' coat down from the hook.',
      }),
      blockMap(after),
      {
        blockReplacements: prepareBlockReplacements({
          before: sourceMap(before),
          after: sourceMap(after),
        }),
      },
    );
    expect(upd.linkStatus).toBe('orphaned');
    expect(upd.blockId).toBeNull();
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

  test('the section the comment was written in outranks filler agreeing elsewhere', () => {
    const blocks = blockMap([
      {
        id: 'ch1',
        text: 'He checks the jacket pocket for the head collar and finds it empty.',
        headingPath: ['Book', 'Chapter 1', 'Elias'],
        sectionIndexPath: [10, 10, 8, 7],
      },
      {
        id: 'ch4',
        text: 'She stands with her braid over one shoulder, her jacket shaped close.',
        headingPath: ['Book', 'Chapter 4', 'Elias'],
        sectionIndexPath: [61, 61, 20, 15],
      },
    ]);
    // ch1 keeps " the " before the quote; ch4 keeps nothing but has the
    // heading path the comment was captured under.
    const upd = reanchor(
      comment({
        anchor_block_id: 'gone',
        anchor_quote: 'jacket',
        anchor_prefix: 'he trades it for the ',
        anchor_suffix: ' he rides in, and goes out',
        anchor_heading_path: JSON.stringify(['Chapter 4', 'Elias']),
        anchor_section_index_path: JSON.stringify([20, 15]),
      }),
      blocks,
    );
    expect(upd.linkStatus).toBe('low-confidence');
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
