/**
 * Run `fn` over each item with at most `limit` concurrent in-flight
 * calls. Preserves input order in the result. Used by route handlers
 * that need bounded parallelism for per-row git reads.
 *
 * `limit` is clamped to a positive integer — `0` would silently skip
 * every item; negative or non-finite values would crash `Array.from`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be a positive integer (got ${limit})`);
  }
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.floor(limit), items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
