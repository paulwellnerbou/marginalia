import { describe, expect, test } from 'bun:test';
import type { TocNode } from './api.js';
import {
  anchorTouchesSections,
  computeSectionRelations,
  threadTouchesSections,
} from './section-filter.js';

function node(id: string, level: number, children: TocNode[] = []): TocNode {
  return { id, level, text: id, children };
}

/**
 *  intro (h1)
 *  ├─ ch1 (h2)
 *  │   ├─ ch1-a (h3)
 *  │   └─ ch1-b (h3)
 *  └─ ch2 (h2)
 *      └─ ch2-a (h3)
 *          └─ ch2-a-1 (h4)
 */
const TOC: TocNode[] = [
  node('intro', 1, [
    node('ch1', 2, [node('ch1-a', 3), node('ch1-b', 3)]),
    node('ch2', 2, [node('ch2-a', 3, [node('ch2-a-1', 4)])]),
  ]),
];

describe('computeSectionRelations', () => {
  test('classifies ancestors, descendants, and unrelated around one selection', () => {
    const relations = computeSectionRelations(TOC, new Set(['ch2-a']));
    expect(relations.get('ch2-a')).toBe('selected');
    expect(relations.get('ch2-a-1')).toBe('descendant');
    expect(relations.get('ch2')).toBe('ancestor');
    expect(relations.get('intro')).toBe('ancestor');
    expect(relations.get('ch1')).toBe('unrelated');
    expect(relations.get('ch1-a')).toBe('unrelated');
    expect(relations.get('ch1-b')).toBe('unrelated');
  });

  test('multiple selections union their subtrees', () => {
    const relations = computeSectionRelations(TOC, new Set(['ch1-a', 'ch2']));
    expect(relations.get('ch1-a')).toBe('selected');
    expect(relations.get('ch2')).toBe('selected');
    expect(relations.get('ch2-a')).toBe('descendant');
    expect(relations.get('ch2-a-1')).toBe('descendant');
    expect(relations.get('ch1')).toBe('ancestor');
    expect(relations.get('ch1-b')).toBe('unrelated');
    expect(relations.get('intro')).toBe('ancestor');
  });

  test('a node inside a selected subtree stays descendant even when it contains another selection', () => {
    const relations = computeSectionRelations(TOC, new Set(['ch2', 'ch2-a-1']));
    expect(relations.get('ch2')).toBe('selected');
    // Above ch2-a-1 but inside ch2's focus — in focus wins.
    expect(relations.get('ch2-a')).toBe('descendant');
    expect(relations.get('ch2-a-1')).toBe('selected');
  });

  test('a selected leaf is selected, not unrelated', () => {
    const relations = computeSectionRelations(TOC, new Set(['ch1-b']));
    expect(relations.get('ch1-b')).toBe('selected');
    expect(relations.get('ch1-a')).toBe('unrelated');
    expect(relations.get('ch1')).toBe('ancestor');
  });

  test('empty selection marks everything unrelated', () => {
    const relations = computeSectionRelations(TOC, new Set());
    for (const value of relations.values()) expect(value).toBe('unrelated');
  });
});

describe('anchorTouchesSections / threadTouchesSections', () => {
  const blockSections = new Map<string, string[]>([
    ['b-preamble', []],
    ['b-ch1', ['intro', 'ch1']],
    ['b-ch1-a', ['intro', 'ch1', 'ch1-a']],
    ['b-ch2-a-1', ['intro', 'ch2', 'ch2-a', 'ch2-a-1']],
  ]);

  test('matches when any chain entry is selected (subtree inclusion)', () => {
    const selected = new Set(['ch2']);
    expect(anchorTouchesSections({ block_id: 'b-ch2-a-1' }, blockSections, selected)).toBe(true);
    expect(anchorTouchesSections({ block_id: 'b-ch1-a' }, blockSections, selected)).toBe(false);
  });

  test('selecting a deep section does not pull in its ancestors sections', () => {
    const selected = new Set(['ch1-a']);
    expect(anchorTouchesSections({ block_id: 'b-ch1-a' }, blockSections, selected)).toBe(true);
    // Block directly under ch1 (a sibling area of ch1-a) stays out.
    expect(anchorTouchesSections({ block_id: 'b-ch1' }, blockSections, selected)).toBe(false);
  });

  test('preamble, orphaned, and unknown blocks never match', () => {
    const selected = new Set(['intro', 'ch1', 'ch2']);
    expect(anchorTouchesSections({ block_id: 'b-preamble' }, blockSections, selected)).toBe(false);
    expect(anchorTouchesSections({ block_id: null }, blockSections, selected)).toBe(false);
    expect(anchorTouchesSections({ block_id: 'b-gone' }, blockSections, selected)).toBe(false);
  });

  test('a multi-block span matches if either endpoint does', () => {
    const selected = new Set(['ch1-a']);
    expect(
      anchorTouchesSections(
        { block_id: 'b-ch1', end_block_id: 'b-ch1-a' },
        blockSections,
        selected,
      ),
    ).toBe(true);
    expect(
      anchorTouchesSections(
        { block_id: 'b-preamble', end_block_id: 'b-ch1' },
        blockSections,
        selected,
      ),
    ).toBe(false);
  });

  test('threadTouchesSections reads the thread anchor', () => {
    const selected = new Set(['ch1']);
    expect(
      threadTouchesSections({ anchor: { block_id: 'b-ch1-a' } }, blockSections, selected),
    ).toBe(true);
    expect(
      threadTouchesSections({ anchor: { block_id: 'b-ch2-a-1' } }, blockSections, selected),
    ).toBe(false);
  });
});
