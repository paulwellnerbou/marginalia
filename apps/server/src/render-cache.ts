import {
  type DocumentFormat,
  type RenderOptions,
  type RenderResult,
  renderDocument,
} from '@marginalia/renderer';

/**
 * Memoized `renderDocument`.
 *
 * Rendering is a pure function of (source, format, options), so the cache
 * is content-addressed and needs no invalidation: a changed document
 * simply hashes to a different key. Keying on content rather than on the
 * document's head commit also covers the reads that are not at head —
 * proposal previews and history diffs render arbitrary snapshots through
 * the same entry point.
 *
 * This matters because the read path re-rendered on every request: a
 * 450 KB markdown document costs ~900 ms and produces ~1.4 MB of HTML,
 * paid again on every reload and every poll.
 */

/**
 * Cache budget in bytes. One entry for a book-length document is a
 * couple of MB, so this is a handful of large documents or a great many
 * small ones. The server runs under a 1 GB container limit and a big
 * export can transiently need a few hundred MB of that, so the default
 * stays well clear of it.
 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function budgetFromEnv(): number {
  const raw = process.env.MARGINALIA_RENDER_CACHE_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  // A malformed budget must not silently disable caching, and a negative
  // one would evict every entry the moment it was stored.
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_BYTES;
  return Math.floor(parsed);
}

const MAX_BYTES = budgetFromEnv();

interface Entry {
  result: RenderResult;
  bytes: number;
}

/** Insertion order is the LRU order; a hit re-inserts to move to the back. */
const entries = new Map<string, Entry>();
/** Renders currently running, so concurrent misses on a key share one. */
const inFlight = new Map<string, Promise<RenderResult>>();
let totalBytes = 0;

let hits = 0;
let misses = 0;
let coalesced = 0;

/**
 * Approximate retained size. `html` dominates by an order of magnitude;
 * the structured fields are counted at a flat rate per anchor/block so a
 * document with thousands of tiny blocks is not costed as though it were
 * free. Exactness does not matter — this only has to keep the cache from
 * outgrowing its budget.
 */
function sizeOf(result: RenderResult): number {
  return (
    result.html.length * 2 +
    (result.anchors.length + result.blocks.length + result.toc.length) * 256 +
    1024
  );
}

/**
 * Stable key for the options that change the output. Listed explicitly
 * rather than via `JSON.stringify(options)`, whose key order follows
 * construction order and would split the cache on equivalent inputs.
 *
 * `highlight` is an object; it is stringified because its own shape is
 * the renderer's business, and it is small.
 */
function optionsKey(options: RenderOptions): string {
  return `${options.mermaid ?? 'client'}|${JSON.stringify(options.highlight ?? {})}`;
}

async function keyFor(
  source: string,
  format: DocumentFormat,
  options: RenderOptions,
): Promise<string> {
  // SHA-256 rather than a fast non-cryptographic hash: a collision here
  // would serve one document's HTML for another, which is worse than any
  // render cost this saves. Hashing 450 KB takes ~1 ms against a ~900 ms
  // render.
  const digest = new Bun.CryptoHasher('sha256').update(source).digest('hex');
  return `${format}|${optionsKey(options)}|${source.length}|${digest}`;
}

function evictTo(limit: number): void {
  for (const [key, entry] of entries) {
    if (totalBytes <= limit) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
  }
}

/**
 * `renderDocument`, served from cache when the same source has been
 * rendered before.
 *
 * The returned `RenderResult` is shared with every other holder of the
 * same key, so callers must treat it as read-only. `renderDocumentCopy`
 * exists for the callers that mutate.
 */
export async function renderDocumentCached(
  source: string,
  format: DocumentFormat,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const key = await keyFor(source, format, options);
  const hit = entries.get(key);
  if (hit) {
    hits += 1;
    // Re-insert to move this entry to the back of the LRU order.
    entries.delete(key);
    entries.set(key, hit);
    return hit.result;
  }

  // Join a render already running for this key rather than starting a
  // second one. The case this exists for is the one that hurts most: a
  // deploy empties the cache, several readers open the same large
  // document at once, and each would otherwise pay the full render.
  const running = inFlight.get(key);
  if (running) {
    coalesced += 1;
    return running;
  }

  misses += 1;
  const render = (async () => {
    const result = await renderDocument(source, format, options);
    store(key, result);
    return result;
  })();
  inFlight.set(key, render);
  try {
    return await render;
  } finally {
    // Only clear our own entry; a later call may already have claimed the
    // key. A failed render leaves nothing behind, so the next caller
    // retries rather than inheriting the rejection.
    if (inFlight.get(key) === render) inFlight.delete(key);
  }
}

/**
 * Put a finished render in the cache, keeping `totalBytes` equal to what
 * the map actually holds.
 *
 * Discounting any entry already under this key is what makes that true:
 * an overwrite replaces one entry but would otherwise add its bytes a
 * second time, and the accounting would drift up until `evictTo` began
 * shedding entries the budget could well afford — eventually emptying
 * the map while the phantom total kept it evicting.
 */
function store(key: string, result: RenderResult): void {
  const bytes = sizeOf(result);
  // A single document larger than the whole budget would evict everything
  // and still not fit; serve it without caching rather than thrashing.
  if (bytes > MAX_BYTES) return;
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.bytes;
  entries.set(key, { result, bytes });
  totalBytes += bytes;
  evictTo(MAX_BYTES);
}

/**
 * As `renderDocumentCached`, but returns a shallow copy so the caller can
 * replace top-level fields — `html`, after asset-reference rewriting —
 * without corrupting the shared entry. Nested values are still shared and
 * must not be mutated in place.
 */
export async function renderDocumentCopy(
  source: string,
  format: DocumentFormat,
  options: RenderOptions = {},
): Promise<RenderResult> {
  return { ...(await renderDocumentCached(source, format, options)) };
}

/**
 * Cache counters, read by this module's tests. Deliberately not served
 * over HTTP: `/api/version` is unauthenticated and polled by every
 * client to spot a new deploy, which is no place for server internals.
 */
export function renderCacheStats(): {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  /** Reads that joined a render already in progress instead of starting one. */
  coalesced: number;
} {
  return { entries: entries.size, bytes: totalBytes, maxBytes: MAX_BYTES, hits, misses, coalesced };
}

/** Test seam — the cache is process-global and would leak between cases. */
export function resetRenderCache(): void {
  entries.clear();
  inFlight.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
  coalesced = 0;
}
