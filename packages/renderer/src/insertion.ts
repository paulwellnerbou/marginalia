/**
 * Joining new text onto a block of existing source. The editor's Append
 * and the MCP's `propose_insertion` both propose a block extended by an
 * insertion; accepting either splices the result over the block's range,
 * so both must leave the same seam.
 */

/** Drop blank lines from both ends; the first line's indentation is content. */
export function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/u, '').replace(/\s+$/u, '');
}

/**
 * `block` followed by `insertion`, one blank line between. Only that seam
 * gains one: the blank line towards the block's next neighbour stays where
 * it was, outside the range in Markdown and at the end of it in AsciiDoc,
 * whose ranges carry their trailing newlines — so those move past the
 * insertion.
 */
export function insertAfterBlock(block: string, insertion: string): string {
  const kept = block.trimEnd();
  return `${kept}\n\n${trimBlankLines(insertion)}${block.slice(kept.length)}`;
}

/** `insertion`, one blank line, then `block`. */
export function insertBeforeBlock(insertion: string, block: string): string {
  return `${trimBlankLines(insertion)}\n\n${block}`;
}
