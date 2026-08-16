import { describe, expect, test } from 'bun:test';
import { renderDocument } from '@marginalia/renderer';
import type { DocumentWire, ThreadWire } from '../src/api-types.js';
import { buildBlockMap, type DocumentBlock, type DocumentBlockMap } from '../src/blocks.js';
import { type ContextScope, documentHeader, threadDetail, threadList } from '../src/format.js';

const SOURCE = `# Guide

- alpha item
- beta item
`;

async function documentWire(
  overrides: Partial<DocumentWire> = {},
  source = SOURCE,
): Promise<DocumentWire> {
  const rendered = await renderDocument(source, 'markdown');
  return {
    uid: 'test-uid',
    name: 'Guide',
    source,
    rendered: {
      html: rendered.html,
      anchors: rendered.anchors,
      toc: rendered.toc,
      blocks: rendered.blocks,
      frontmatter: rendered.frontmatter,
      warnings: rendered.warnings,
    },
    attached_assets: [],
    format: 'markdown',
    default_theme: 'default',
    password_protected: false,
    role: 'admin',
    display_name: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

async function blockMap(source = SOURCE): Promise<DocumentBlockMap> {
  return buildBlockMap(await documentWire({}, source));
}

/** The wire shape of a comment thread, with only the anchor varying. */
function threadOn(blockId: string | null, endBlockId: string | null): ThreadWire {
  return {
    id: 'thread-1',
    state: 'open',
    resolution: null,
    link_status: 'linked',
    anchor: {
      block_id: blockId,
      end_block_id: endBlockId,
      quote: 'alpha item\n\nbeta item',
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: 21,
      heading_path: ['Guide'],
      section_index: 0,
      section_index_path: [0],
    },
    capabilities: {
      reply: true,
      resolve: true,
      accept: false,
      reject: false,
      update: false,
      repair: false,
      reopen: false,
    },
    answered_by_thread_ids: [],
    proposal: null,
    comments: [
      {
        id: 'thread-1',
        body: 'Both of these need a source.',
        author: { client_id: 'reviewer', display_name: 'Paul' },
        capabilities: { edit: false, delete: false, react: true },
        reactions: [],
        created_at: 0,
        updated_at: 0,
      },
    ],
  };
}

const options = (map: DocumentBlockMap | null, context: ContextScope = 'block') => ({
  context,
  blockMap: map,
  ref: { baseUrl: 'https://marginalia.test', uid: 'test-uid', token: 'secret-invite-token-1' },
});

describe('threadDetail anchors', () => {
  test('names both endpoints of a span', async () => {
    const map = await blockMap();
    const items = map.blocks.filter((b) => b.kind === 'listItem');
    const out = threadDetail(
      threadOn((items[0] as DocumentBlock).id, (items[1] as DocumentBlock).id),
      1,
      1,
      options(map),
    );

    expect(out).toContain(`end_block_id=${(items[1] as DocumentBlock).id}`);
    expect(out).toContain('listItem…listItem span, lines 3-4');
  });

  test('still reports a span whose end block is no longer in the document', async () => {
    const map = await blockMap();
    const items = map.blocks.filter((b) => b.kind === 'listItem');
    // The id an edit left behind: the anchor still names it, the current
    // block map has no such block.
    const out = threadDetail(
      threadOn((items[0] as DocumentBlock).id, 'ffffffffffffffff'),
      1,
      1,
      options(map),
    );

    // Losing the end id here would present a truncated quote as complete.
    expect(out).toContain('end_block_id=ffffffffffffffff');
    expect(out).toContain('end block not in this document');
    // And the source shown is only the span's start, so it must not be
    // labelled as though it were the whole anchor.
    expect(out).toContain('the START of the span only');
    expect(out).toContain('- alpha item');
    expect(out).not.toContain('- beta item');
  });

  test('does not invent line numbers for a block it could not place', async () => {
    const map = await blockMap();
    const items = map.blocks.filter((b) => b.kind === 'listItem');
    const unplaced: DocumentBlock = {
      ...(items[1] as DocumentBlock),
      source: null,
      start: null,
      end: null,
      startLine: null,
      endLine: null,
    };
    const drifted: DocumentBlockMap = {
      ...map,
      blocks: map.blocks.map((b) => (b.id === unplaced.id ? unplaced : b)),
    };

    const out = threadDetail(
      threadOn((items[0] as DocumentBlock).id, unplaced.id),
      1,
      1,
      options(drifted),
    );

    expect(out).toContain('source range unknown');
    expect(out).not.toContain('lines 0-');
    expect(out).not.toContain('-0)');
  });

  test('falls back to the heading path when no block resolves', async () => {
    const out = threadDetail(threadOn('ffffffffffffffff', null), 1, 1, options(null));
    expect(out).toContain('section Guide');
    expect(out).not.toContain('end_block_id=');
  });
});

describe('threadDetail section context', () => {
  const BOOK = `# Manual

## Setup

Install it first.

## Usage

Run the thing.

### Flags

- verbose mode
- quiet mode
`;

  test('prints the innermost section around the anchor, not the whole chapter', async () => {
    const map = await blockMap(BOOK);
    const item = map.blocks.find((b) => b.kind === 'listItem') as DocumentBlock;
    const out = threadDetail(threadOn(item.id, null), 1, 1, options(map, 'section'));

    expect(out).toContain('section source — Manual › Usage › Flags');
    expect(out).toContain('### Flags');
    expect(out).toContain('- verbose mode');
    // The enclosing chapter is a `get_document` call away; printing it
    // here would make "section" mean the whole document for a comment
    // deep in the tree.
    expect(out).not.toContain('Run the thing');
  });

  test('recovers a section for a thread whose anchor block is gone', async () => {
    const map = await blockMap(BOOK);
    const orphan: ThreadWire = {
      ...threadOn(null, null),
      link_status: 'orphaned',
      anchor: { ...threadOn(null, null).anchor, heading_path: ['Manual', 'Setup'] },
    };
    const out = threadDetail(orphan, 1, 1, options(map, 'section'));

    // No block to neighbour, so this is the only setting under which an
    // orphan arrives with any of the text it was written about.
    expect(out).toContain('section source — Manual › Setup');
    expect(out).toContain('Install it first.');
  });

  test('prints a shared section once and points the rest at it', async () => {
    const map = await blockMap(BOOK);
    const items = map.blocks.filter((b) => b.kind === 'listItem');
    const out = threadList(
      [
        { ...threadOn((items[0] as DocumentBlock).id, null), id: 'thread-a' },
        { ...threadOn((items[1] as DocumentBlock).id, null), id: 'thread-b' },
      ],
      options(map, 'section'),
    );

    expect(out.match(/- verbose mode/g)?.length).toBe(2);
    // Twice as the anchored blocks themselves, but the surrounding
    // section body only once.
    expect(out.match(/^\s*\| ### Flags$/gm)?.length).toBe(1);
    expect(out).toContain('printed above under thread thread-a');
  });

  test('names what the response budget withheld instead of trimming quietly', async () => {
    // Chapters big enough that the third cannot fit in what the first two
    // leave of the per-response budget. Two paragraphs each, so the last
    // chapter is reached twice — once withheld, once a repeat of it.
    // Every paragraph's text differs per chapter: block ids are content
    // hashes, so repeating one verbatim would give two chapters a block
    // with the same id and send the lookup to whichever came first.
    const chapters = [1, 2, 3]
      .map(
        (n) =>
          `## Chapter ${n}\n\n${`Sentence ${n}. `.repeat(600)}\n\n${`Filler ${n}. `.repeat(900)}\n`,
      )
      .join('\n');
    const map = await blockMap(`# Epic\n\n${chapters}`);
    const paragraphs = map.blocks.filter((b) => b.kind === 'paragraph');
    expect(paragraphs.length).toBe(6);
    const out = threadList(
      paragraphs.map((b, i) => ({ ...threadOn(b.id, null), id: `thread-${i}` })),
      options(map, 'section'),
    );

    expect(out).toContain('truncated at');
    expect(out).toContain('withheld — this response’s section budget is spent');
    expect(out).toContain('get_document with section: "Epic > Chapter 3"');
    // Chapter 3 was withheld, so the second thread in it must not claim
    // the text is above — that would send the reader looking for prose
    // this response never contained.
    expect(out).not.toContain('printed above under thread thread-4');
    expect(out.match(/withheld — this response’s section budget is spent/g)?.length).toBe(2);
    // The chapters that did fit still dedupe normally.
    expect(out).toContain('printed above under thread thread-0');
  });

  test('says a thread outside every section has no section to show', async () => {
    // Text before the first heading belongs to no section.
    const map = await blockMap('Loose intro.\n\n# Manual\n\nBody.\n');
    const intro = map.blocks.find((b) => b.kind === 'paragraph') as DocumentBlock;
    const out = threadDetail(threadOn(intro.id, null), 1, 1, options(map, 'section'));
    expect(out).toContain('section source: unavailable');
  });
});

describe('threadDetail links', () => {
  test('carries a token-free deep link to the thread', async () => {
    const out = threadDetail(threadOn(null, null), 1, 1, options(null));
    // Token-free on purpose: opening /d/<uid>/<token> claims that invite,
    // so a link with the agent's token would hijack whoever clicks it.
    expect(out).toContain('url: https://marginalia.test/d/test-uid#comment-thread-1');
    expect(out).not.toContain('secret-invite-token-1');
  });
});

describe('documentHeader access guidance', () => {
  const ref = {
    baseUrl: 'https://marginalia.test',
    uid: 'test-uid',
    token: 'secret-invite-token-1',
  };

  test('offers the share url as something to hand a person on an open document', async () => {
    const doc = await documentWire();
    const out = documentHeader(doc, ref, await blockMap());
    expect(out).toContain('use this when telling a person where something is');
    expect(out).not.toContain('access: invite-only');
  });

  test('withdraws that advice on an invite-only document', async () => {
    const doc = await documentWire({ invite_only: true });
    const out = documentHeader(doc, ref, await blockMap());
    // The share url still exists — it's the correct link to name the
    // document — but handing it to someone is no longer a way to give
    // them access, and saying so is the whole point of the flag.
    expect(out).toContain('share url: https://marginalia.test/d/test-uid');
    expect(out).not.toContain('use this when telling a person where something is');
    expect(out).toContain('this document is invite-only');
    expect(out).toContain('access: invite-only');
  });
});
