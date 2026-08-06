import { describe, expect, test } from 'bun:test';
import { joinSpanQuote } from '@marginalia/renderer/anchor-span';
import { highlightRange } from './block-span.js';

describe('highlightRange', () => {
  test('single block: offsets pass through', () => {
    expect(
      highlightRange({ quote: 'brown fox', start_offset: 4, end_offset: 13, end_block_id: null }),
    ).toEqual({ startOffset: 4, endOffset: 13 });
  });

  test('single block: a degenerate range is rejected', () => {
    expect(
      highlightRange({ quote: 'brown fox', start_offset: 13, end_offset: 13, end_block_id: null }),
    ).toBeNull();
    expect(
      highlightRange({ quote: 'brown fox', start_offset: 20, end_offset: 13, end_block_id: null }),
    ).toBeNull();
  });

  test('single block: null offsets fall back to the whole quote', () => {
    expect(
      highlightRange({
        quote: 'brown fox',
        start_offset: null,
        end_offset: null,
        end_block_id: null,
      }),
    ).toEqual({ startOffset: 0, endOffset: 'brown fox'.length });
  });

  test('an empty quote is never paintable', () => {
    expect(
      highlightRange({ quote: '', start_offset: 0, end_offset: 5, end_block_id: 'b2' }),
    ).toBeNull();
    expect(
      highlightRange({ quote: null, start_offset: 0, end_offset: 5, end_block_id: null }),
    ).toBeNull();
  });

  test('span: end_offset below start_offset is still paintable', () => {
    // The two index different blocks — starting late in the first block
    // and ending early in the last is an ordinary selection, not an
    // inverted range. Comparing them would drop the highlight entirely.
    const quote = joinSpanQuote(['tail end of a long opening paragraph', 'Final']);
    expect(highlightRange({ quote, start_offset: 42, end_offset: 5, end_block_id: 'b2' })).toEqual({
      startOffset: 42,
      endOffset: 5,
    });
  });

  test('span: null end_offset falls back to the trailing fragment, not the whole quote', () => {
    const quote = joinSpanQuote(['head fragment', 'middle block text', 'tail']);
    expect(
      highlightRange({ quote, start_offset: null, end_offset: null, end_block_id: 'b3' }),
    ).toEqual({
      startOffset: 0,
      endOffset: 'tail'.length,
    });
  });
});
