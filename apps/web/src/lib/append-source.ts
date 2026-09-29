import { trimBlankLines } from '@marginalia/renderer/insertion';

/**
 * The document with `addition` after its last line, a blank line between
 * them: without one, Markdown reads text straight after a paragraph as
 * more of that paragraph, and AsciiDoc does the same.
 */
export function appendSource(source: string, addition: string): string {
  const text = trimBlankLines(addition);
  if (!text) return source;
  if (!source.trim()) return `${text}\n`;
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${text}\n`;
}

interface Range {
  start: number;
  end: number;
}

/**
 * The block the document ends with. Where a list and its last item end
 * together, the list: an addition spliced after the item would land
 * inside the list.
 */
export function lastBlock<R extends Range>(ranges: ReadonlyMap<string, R>): [string, R] | null {
  let last: [string, R] | null = null;
  for (const entry of ranges) {
    const [, range] = entry;
    if (
      !last ||
      range.end > last[1].end ||
      (range.end === last[1].end && range.start < last[1].start)
    ) {
      last = entry;
    }
  }
  return last;
}

/**
 * The first block starting at or after `offset`: where appended text
 * begins. The outermost block wins a tie, a list over its first item.
 */
export function firstBlockFrom<R extends Range>(
  ranges: ReadonlyMap<string, R>,
  offset: number,
): string | null {
  let first: [string, R] | null = null;
  for (const entry of ranges) {
    const [, range] = entry;
    if (range.start < offset) continue;
    if (
      !first ||
      range.start < first[1].start ||
      (range.start === first[1].start && range.end > first[1].end)
    ) {
      first = entry;
    }
  }
  return first?.[0] ?? null;
}
