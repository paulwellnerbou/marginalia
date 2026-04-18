/**
 * Block-id helpers shared by the remark plugin (which writes
 * `data-block` / `data-subblock` attributes during rendering) and by
 * `locate-block.ts` (which re-parses the source to round-trip an id back
 * to a source range).
 *
 * Both walk the same tree in the same order and must produce the same
 * ids — keep every piece of id derivation here, not duplicated.
 */

/**
 * Normalize a block's plain text for hashing. Collapses runs of whitespace
 * to a single space and trims. Capitalization is preserved on purpose —
 * changing case is a meaningful block edit, not a formatting change.
 */
export function normalizeBlockText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Short content hash — 64 bits of FNV-1a. IDs are local to one document;
 * collisions at this bit width are vanishingly rare for reasonable block
 * counts, and a collision only causes two different blocks to share an
 * anchor (which the re-anchoring flow handles gracefully).
 */
export function hashBlock(kind: string, text: string): string {
  const input = `${kind}\u0000${text}`;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Compute a sub-block id (`listItem` / `tableCell`) that stays unique even
 * when two siblings share the same normalized text (common in tables —
 * "Yes"/"No", numeric values, repeated labels).
 *
 * `counts` is the caller's running state. Pass the SAME map across every
 * sub-block in document order so two independent walkers over the same
 * document produce identical ids. First occurrence returns the raw content
 * hash; subsequent duplicates are suffixed `#2`, `#3`, ….
 *
 * Top-level blocks deliberately do NOT go through this helper — their ids
 * feed comment anchoring, which tolerates duplicate-content collisions via
 * the re-anchoring heuristics and does not want drift from a sibling being
 * added or removed.
 */
export function computeSubBlockId(
  kind: 'listItem' | 'tableCell',
  normalizedText: string,
  counts: Map<string, number>,
): string {
  const base = hashBlock(kind, normalizedText);
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}
