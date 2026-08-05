import { describe, expect, test } from 'bun:test';
import {
  joinSpanQuote,
  SPAN_SEPARATOR,
  spanHead,
  spanTail,
  splitSpanQuote,
} from '../src/anchor-span.js';
import { normalizeBlockText } from '../src/block-ids-shared.js';

describe('span quotes', () => {
  test('a single-block quote splits to exactly itself', () => {
    expect(splitSpanQuote('The quick brown fox')).toEqual(['The quick brown fox']);
    expect(spanHead('The quick brown fox')).toBe('The quick brown fox');
    expect(spanTail('The quick brown fox')).toBe('The quick brown fox');
  });

  test('round-trips a multi-block quote', () => {
    const fragments = ['tail of the first', 'a whole middle block', 'head of the last'];
    const quote = joinSpanQuote(fragments);
    expect(splitSpanQuote(quote)).toEqual(fragments);
    expect(spanHead(quote)).toBe('tail of the first');
    expect(spanTail(quote)).toBe('head of the last');
  });

  test('the separator cannot occur inside a normalized fragment', () => {
    // The whole convention rests on this: block text is normalized before
    // it ever reaches a quote, so no fragment can contain a newline.
    const normalized = normalizeBlockText('a line\n\nand another\ttab');
    expect(normalized).toBe('a line and another tab');
    expect(normalized.includes(SPAN_SEPARATOR)).toBe(false);
    expect(splitSpanQuote(joinSpanQuote([normalized, normalized]))).toHaveLength(2);
  });

  test('an empty trailing fragment still round-trips', () => {
    expect(splitSpanQuote(joinSpanQuote(['head', '']))).toEqual(['head', '']);
    expect(spanTail(joinSpanQuote(['head', '']))).toBe('');
  });
});
