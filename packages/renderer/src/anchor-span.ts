/**
 * A comment anchor may cover several blocks. The anchor then stores the
 * first block's id in `block_id`, the last block's id in `end_block_id`,
 * and one quote holding every covered block's selected text joined by
 * `SPAN_SEPARATOR`.
 *
 * The separator is safe because every fragment is run through
 * `normalizeBlockText` first, which collapses `\s+` to a single space —
 * so no fragment can ever contain a newline and the join round-trips.
 *
 * Single-block anchors are unchanged: one fragment, no separator, which
 * is why every anchor written before spans existed still splits to
 * exactly itself.
 */
export const SPAN_SEPARATOR = '\n\n';

export function joinSpanQuote(fragments: readonly string[]): string {
  return fragments.join(SPAN_SEPARATOR);
}

export function splitSpanQuote(quote: string): string[] {
  return quote.split(SPAN_SEPARATOR);
}

/** The part of a span quote that belongs to `block_id`. */
export function spanHead(quote: string): string {
  const idx = quote.indexOf(SPAN_SEPARATOR);
  return idx < 0 ? quote : quote.slice(0, idx);
}

/** The part of a span quote that belongs to `end_block_id`. */
export function spanTail(quote: string): string {
  const idx = quote.lastIndexOf(SPAN_SEPARATOR);
  return idx < 0 ? quote : quote.slice(idx + SPAN_SEPARATOR.length);
}
