import { describe, expect, test } from 'bun:test';
import type { ThreadAnchor } from '../../lib/api.js';
import { buildThreadLocationIndex, threadHeadingPath } from './threadLocation.js';

function block(id: string, headingPath: string[], sectionIndexPath: number[]) {
  return {
    id,
    headingPath,
    sectionIndex: sectionIndexPath[sectionIndexPath.length - 1]!,
    sectionIndexPath,
  };
}

function anchor(over: Partial<ThreadAnchor>): ThreadAnchor {
  return {
    block_id: null,
    quote: null,
    prefix: '',
    suffix: '',
    start_offset: null,
    end_offset: null,
    heading_path: null,
    section_index: null,
    section_index_path: null,
    ...over,
  };
}

describe('threadHeadingPath', () => {
  test('reads the current section, not the one the anchor stored', () => {
    const index = buildThreadLocationIndex([
      block('a', ['Chapter 1'], [0, 0]),
      block('b', ['Chapter 2', 'Arrival'], [1, 0, 0]),
    ]);
    const stale = anchor({ block_id: 'b', heading_path: ['Chapter 2', 'Old name'] });
    expect(threadHeadingPath(index, stale)).toEqual(['Chapter 2', 'Arrival']);
  });

  test('a repeated block resolves by the stored section', () => {
    const index = buildThreadLocationIndex([
      block('x', ['Chapter 1', 'Elias'], [0, 0, 0]),
      block('x', ['Chapter 2', 'Elias'], [1, 0, 0]),
    ]);
    const second = anchor({
      block_id: 'x',
      heading_path: ['Chapter 2', 'Elias'],
      section_index_path: [1, 0, 0],
    });
    expect(threadHeadingPath(index, second)).toEqual(['Chapter 2', 'Elias']);
  });

  test('falls back to the stored path when the block is gone', () => {
    const index = buildThreadLocationIndex([block('a', ['Chapter 1'], [0, 0])]);
    const orphan = anchor({ block_id: null, heading_path: ['Chapter 9'] });
    expect(threadHeadingPath(index, orphan)).toEqual(['Chapter 9']);
  });

  test('drops a title heading every section sits under', () => {
    const index = buildThreadLocationIndex([
      block('pre', [], [0]),
      block('t', ['Book'], [1, 0]),
      block('c', ['Book', 'Chapter 3', 'Scene'], [2, 1, 0, 0]),
    ]);
    expect(threadHeadingPath(index, anchor({ block_id: 'c' }))).toEqual(['Chapter 3', 'Scene']);
    expect(threadHeadingPath(index, anchor({ block_id: 't' }))).toEqual([]);
  });

  test('keeps the top level when the document has several', () => {
    const index = buildThreadLocationIndex([
      block('a', ['Part I'], [0, 0]),
      block('b', ['Part II', 'Chapter 3'], [1, 0, 0]),
    ]);
    expect(threadHeadingPath(index, anchor({ block_id: 'b' }))).toEqual(['Part II', 'Chapter 3']);
  });
});
