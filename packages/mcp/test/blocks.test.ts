import { describe, expect, test } from 'bun:test';
import { renderDocument } from '@marginalia/renderer';
import type { DocumentWire } from '../src/api-types.js';
import {
  buildAnchor,
  buildBlockMap,
  type DocumentBlock,
  resolveBlock,
  resolveSection,
  sectionContains,
} from '../src/blocks.js';

const SOURCE = `# Guide

Intro paragraph with a distinctive phrase inside it.

## Details

- alpha item
- beta item

| head | other |
| ---- | ----- |
| cell | value |
`;

/** A DocumentWire built from the real renderer, matching what the server returns. */
async function documentFrom(source: string): Promise<DocumentWire> {
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
  };
}

describe('buildBlockMap', () => {
  test('pairs every rendered block with its verbatim source', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    expect(map.unresolved).toEqual([]);

    const heading = map.blocks.find((b) => b.kind === 'heading') as DocumentBlock;
    expect(heading.source).toBe('# Guide');
    expect(heading.startLine).toBe(1);

    const paragraph = map.blocks.find((b) => b.kind === 'paragraph') as DocumentBlock;
    expect(paragraph.source).toBe('Intro paragraph with a distinctive phrase inside it.');
    expect(paragraph.headingPath).toEqual(['Guide']);
  });

  test('exposes list items and table cells as their own blocks', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const item = map.blocks.find((b) => b.kind === 'listItem' && b.text === 'alpha item');
    expect(item?.source).toBe('- alpha item');

    const cell = map.blocks.find((b) => b.kind === 'tableCell' && b.text === 'cell');
    // A cell's range excludes the surrounding pipes, so a proposal can't break the table.
    expect(cell?.source).toBe('cell');
  });
});

const NESTED = `# Book

Preface paragraph.

## One

Alpha.

### One A

Alpha nested.

## Two

Beta.
`;

describe('sections', () => {
  test('runs from a heading to the next heading at the same or shallower depth', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    const one = resolveSection(map, 'One');
    expect(one.source).toBe('## One\n\nAlpha.\n\n### One A\n\nAlpha nested.');
    expect(one.path).toEqual(['Book', 'One']);
    expect(one.depth).toBe(2);

    // A deeper heading ends at the next same-or-shallower one, not at EOF.
    const oneA = resolveSection(map, 'One A');
    expect(oneA.source).toBe('### One A\n\nAlpha nested.');

    // The last section runs to the end of the document.
    expect(resolveSection(map, 'Two').source).toBe('## Two\n\nBeta.');
  });

  test('a parent section contains its children and the text before them', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    const book = resolveSection(map, 'Book');
    expect(book.source).toContain('Preface paragraph.');
    expect(book.source).toContain('Alpha nested.');
    expect(book.source).toContain('Beta.');
  });

  test('reports line ranges that match the source', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    const two = resolveSection(map, 'Two');
    expect(
      NESTED.split('\n')
        .slice(two.startLine - 1, two.endLine)
        .join('\n'),
    ).toBe(two.source);
  });

  test('carries the anchor slug for #fragment addressing', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    expect(resolveSection(map, 'One A').slug).toBe('one-a');
    expect(resolveSection(map, '#one-a').heading).toBe('One A');
  });

  test('sectionContains covers a child section’s blocks', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    const one = resolveSection(map, 'One');
    const nested = map.blocks.find((b) => b.text === 'Alpha nested.') as DocumentBlock;
    const outside = map.blocks.find((b) => b.text === 'Beta.') as DocumentBlock;
    expect(sectionContains(one, nested)).toBe(true);
    expect(sectionContains(one, outside)).toBe(false);
  });

  test('an exact heading match beats a substring one', async () => {
    const map = await buildBlockMap(await documentFrom(NESTED));
    // 'One' is a substring of 'One A' too; the exact match must win.
    expect(resolveSection(map, 'One').heading).toBe('One');
  });

  test('says so when the document has no headings', async () => {
    const map = await buildBlockMap(await documentFrom('Just a paragraph.\n'));
    expect(map.sections).toEqual([]);
    expect(() => resolveSection(map, 'anything')).toThrow(/no headings/);
  });
});

describe('resolveBlock', () => {
  test('finds the block a source snippet lives in', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const block = resolveBlock(map, { anchorText: 'distinctive phrase' });
    expect(block.kind).toBe('paragraph');
  });

  test('prefers a list item over the list that contains it', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const block = resolveBlock(map, { anchorText: 'beta item' });
    expect(block.kind).toBe('listItem');
    expect(block.source).toBe('- beta item');
  });

  test('reports ambiguity when the text occurs in unrelated blocks', async () => {
    const map = await buildBlockMap(await documentFrom('First shared.\n\nSecond shared.\n'));
    expect(() => resolveBlock(map, { anchorText: 'shared' })).toThrow(/ambiguous/);
  });

  test('explains an unknown block id instead of guessing', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    expect(() => resolveBlock(map, { blockId: 'ffffffffffffffff' })).toThrow(/call list_blocks/);
  });

  test('requires some selector', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    expect(() => resolveBlock(map, {})).toThrow(/block_id or anchor_text/);
  });
});

describe('buildAnchor', () => {
  test('locates the quote inside the block text and captures context', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const paragraph = map.blocks.find((b) => b.kind === 'paragraph') as DocumentBlock;
    const anchor = buildAnchor(paragraph, 'distinctive phrase');

    expect(anchor.block_id).toBe(paragraph.id);
    expect(anchor.quote).toBe('distinctive phrase');
    expect(paragraph.text.slice(anchor.start_offset, anchor.end_offset)).toBe('distinctive phrase');
    expect(anchor.prefix).toBe('Intro paragraph with a ');
    expect(anchor.suffix).toBe(' inside it.');
    expect(anchor.heading_path).toEqual(['Guide']);
  });

  test('falls back to the whole block when the quote is markdown syntax', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const heading = map.blocks.find((b) => b.kind === 'heading') as DocumentBlock;
    // '# Guide' is source, not rendered text — anchoring must not silently
    // produce an offset that points nowhere.
    const anchor = buildAnchor(heading, '# Guide');
    expect(anchor.quote).toBe('Guide');
    expect(anchor.start_offset).toBe(0);
  });

  test('collapses whitespace so a quote spanning a soft wrap still matches', async () => {
    const map = await buildBlockMap(await documentFrom('One two\nthree four.\n'));
    const paragraph = map.blocks[0] as DocumentBlock;
    const anchor = buildAnchor(paragraph, 'two\nthree');
    expect(anchor.quote).toBe('two three');
    expect(anchor.start_offset).toBe(4);
  });

  test('records a multi-block span through end_block_id', async () => {
    const map = await buildBlockMap(await documentFrom(SOURCE));
    const items = map.blocks.filter((b) => b.kind === 'listItem');
    const anchor = buildAnchor(items[0] as DocumentBlock, undefined, items[1] as DocumentBlock);
    expect(anchor.end_block_id).toBe((items[1] as DocumentBlock).id);
  });
});

describe('line numbers', () => {
  test('are correct at every block, including the first and last line', async () => {
    const source = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const map = await buildBlockMap(await documentFrom(source));
    expect(map.blocks).toHaveLength(200);

    // Paragraph n sits on line 2n-1 given the blank line between each.
    map.blocks.forEach((block, i) => {
      expect(block.startLine).toBe(2 * i + 1);
      expect(block.endLine).toBe(2 * i + 1);
    });
    // And the reported line really contains the block.
    const last = map.blocks[map.blocks.length - 1] as DocumentBlock;
    expect(source.split('\n')[(last.startLine as number) - 1]).toBe('Paragraph 200.');
  });

  test('handle a block spanning several lines', async () => {
    const map = await buildBlockMap(
      await documentFrom('First.\n\nline one\nline two\nline three\n'),
    );
    const wrapped = map.blocks[1] as DocumentBlock;
    expect(wrapped.startLine).toBe(3);
    expect(wrapped.endLine).toBe(5);
  });
});
