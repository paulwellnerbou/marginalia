/**
 * A block to bring into view when a document next opens in the viewer,
 * such as the first block of text the editor just appended. Held in
 * memory rather than in the URL, so a reload or a shared link does not
 * jump there again.
 */
let pending: { uid: string; blockId: string } | null = null;

export function revealOnOpen(uid: string, blockId: string): void {
  pending = { uid, blockId };
}

/** The block waiting for `uid`, handed out once. */
export function takeRevealOnOpen(uid: string): string | null {
  if (pending?.uid !== uid) return null;
  const { blockId } = pending;
  pending = null;
  return blockId;
}
