import type { BlockSourceRange } from '@marginalia/renderer';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import type { DocumentFormat } from './db.js';

/**
 * Memoized block-range lookup.
 *
 * Locating every block's source range means parsing the whole document —
 * about half a second for a book-length one — and the write paths ask for
 * it twice: once for the source as it was, once for the source as it now
 * is. Saving, accepting a proposal, restoring and reverting all pay that
 * pair.
 *
 * The second of those pairs is a fresh parse either way. The first is
 * almost always one this process has already done: the "before" side of
 * this edit is the "after" side of the last one. A reviewer working
 * through a queue of proposals therefore pays one parse per accept rather
 * than two.
 *
 * Content-addressed for the same reason the render cache is — a changed
 * document hashes to a different key, so there is no invalidation to get
 * wrong, and reads of older snapshots (history diffs, proposal previews)
 * share the cache instead of fighting it.
 */

/**
 * Documents to keep block maps for. A map is one entry per block holding
 * two integers — a couple of hundred kilobytes for a very long document,
 * so this is far cheaper than the render cache and bounded by count
 * rather than by bytes.
 */
const MAX_ENTRIES = 16;

/** Insertion order is the LRU order; a hit re-inserts to move to the back. */
const entries = new Map<string, ReadonlyMap<string, BlockSourceRange>>();

let hits = 0;
let misses = 0;

function keyFor(source: string, format: DocumentFormat): string {
  // SHA-256, not a fast non-cryptographic hash: a collision would apply
  // one document's block ranges to another and silently splice an edit
  // into the wrong place. Hashing is a rounding error against the parse
  // it avoids.
  const digest = new Bun.CryptoHasher('sha256').update(source).digest('hex');
  return `${format}|${source.length}|${digest}`;
}

/**
 * Block ranges for a document source.
 *
 * The returned map is shared with every other holder of the same key and
 * must not be mutated — callers only ever read it, which is what makes
 * sharing safe.
 */
export function locateDocumentBlocksCached(
  format: DocumentFormat,
  source: string,
): ReadonlyMap<string, BlockSourceRange> {
  const key = keyFor(source, format);
  const hit = entries.get(key);
  if (hit) {
    hits += 1;
    entries.delete(key);
    entries.set(key, hit);
    return hit;
  }

  misses += 1;
  const blocks = format === 'asciidoc' ? locateAllBlocksAsciidoc(source) : locateAllBlocks(source);
  entries.set(key, blocks);
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  return blocks;
}

/** Diagnostics, read by this module's tests. */
export function blockCacheStats(): { entries: number; hits: number; misses: number } {
  return { entries: entries.size, hits, misses };
}

/** Test seam — the cache is process-global and would leak between cases. */
export function resetBlockCache(): void {
  entries.clear();
  hits = 0;
  misses = 0;
}
