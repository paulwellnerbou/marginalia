import { describe, expect, test } from 'bun:test';
import { renderDocument } from '@marginalia/renderer';
import type { DocumentWire, ThreadWire } from '../src/api-types.js';
import { buildBlockMap, type DocumentBlock, type DocumentBlockMap } from '../src/blocks.js';
import { threadDetail } from '../src/format.js';

const SOURCE = `# Guide

- alpha item
- beta item
`;

async function blockMap(source = SOURCE): Promise<DocumentBlockMap> {
  const rendered = await renderDocument(source, 'markdown');
  const doc: DocumentWire = {
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
  };
  return buildBlockMap(doc);
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

const options = (map: DocumentBlockMap | null) => ({
  includeAnchorSource: true,
  contextBlocks: 0,
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

describe('threadDetail links', () => {
  test('carries a token-free deep link to the thread', async () => {
    const out = threadDetail(threadOn(null, null), 1, 1, options(null));
    // Token-free on purpose: opening /d/<uid>/<token> claims that invite,
    // so a link with the agent's token would hijack whoever clicks it.
    expect(out).toContain('url: https://marginalia.test/d/test-uid#comment-thread-1');
    expect(out).not.toContain('secret-invite-token-1');
  });
});
