import { describe, expect, test } from 'bun:test';
import { MAX_SEGMENT_CHARS, splitIntoSentences } from './segment.js';

describe('splitIntoSentences', () => {
  test('splits on sentence punctuation', () => {
    const text = 'Marginalia rendert Markdown. Das Ergebnis ist HTML! Wirklich?';
    expect(splitIntoSentences(text, 'de').map((span) => span.text)).toEqual([
      'Marginalia rendert Markdown.',
      'Das Ergebnis ist HTML!',
      'Wirklich?',
    ]);
  });

  test('offsets slice back to the original text', () => {
    const text = '  Erster Satz.\n\nZweiter Satz.  ';
    for (const span of splitIntoSentences(text, 'de')) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });

  test('does not split at line breaks inside a sentence', () => {
    // Hard-wrapped markdown source: the newline is whitespace once
    // rendered, but Unicode sentence breaking treats it as terminal.
    const text = 'Dieser Absatz besteht aus\nmehreren Sätzen, damit es auffällt. Ende.';
    expect(splitIntoSentences(text, 'de').map((span) => span.text)).toEqual([
      'Dieser Absatz besteht aus mehreren Sätzen, damit es auffällt.',
      'Ende.',
    ]);
  });

  test('offsets stay valid when whitespace is flattened', () => {
    const text = 'Erster Teil\nzweiter Teil. Danach mehr.';
    for (const span of splitIntoSentences(text, 'de')) {
      // Same length either way, so the raw slice matches apart from
      // the whitespace characters themselves.
      expect(text.slice(span.start, span.end).replace(/\s/gu, ' ')).toBe(span.text);
    }
  });

  test('does not split inside decimal numbers', () => {
    const spans = splitIntoSentences('Version 1.5 ist da. Ende.', 'de');
    expect(spans.map((span) => span.text)).toEqual(['Version 1.5 ist da.', 'Ende.']);
  });

  test('drops spans without letters or digits', () => {
    // Horizontal rules and bare bullets carry no speakable content.
    expect(splitIntoSentences('---', 'de')).toEqual([]);
    expect(splitIntoSentences('• — •', 'de')).toEqual([]);
    expect(splitIntoSentences('   ', 'de')).toEqual([]);
  });

  test('never emits leading or trailing whitespace', () => {
    const text = '   Ein Satz mit Rand.   Noch einer.   ';
    for (const span of splitIntoSentences(text, 'de')) {
      expect(span.text).toBe(span.text.trim());
      expect(span.text.length).toBeGreaterThan(0);
    }
  });

  test('caps over-long sentences and keeps every word', () => {
    // One sentence, no internal punctuation to break on.
    const words = Array.from({ length: 120 }, (_, i) => `wort${i}`);
    const text = `${words.join(' ')}.`;

    const spans = splitIntoSentences(text, 'de');
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(span.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    }
    expect(spans.map((span) => span.text).join(' ')).toBe(text);
  });

  test('prefers a clause boundary when capping', () => {
    const head = `${'a'.repeat(MAX_SEGMENT_CHARS - 20)}, `;
    const text = `${head}${'b'.repeat(60)}.`;

    const spans = splitIntoSentences(text, 'de');
    expect(spans[0]?.text.endsWith(',')).toBe(true);
  });

  test('handles text with no terminal punctuation', () => {
    expect(splitIntoSentences('Eine Überschrift ohne Punkt', 'de').map((s) => s.text)).toEqual([
      'Eine Überschrift ohne Punkt',
    ]);
  });

  test('falls back gracefully on an unusable locale tag', () => {
    const spans = splitIntoSentences('Erster Satz. Zweiter Satz.', 'not-a-real-locale');
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.map((span) => span.text).join(' ')).toContain('Zweiter Satz.');
  });
});
