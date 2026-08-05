import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import { locateAllBlocks } from '@marginalia/renderer/locate-block';
import type { BlockInfoWire, DocumentFormat, DocumentWire } from './api-types.js';

/**
 * A block, joined from the two halves Marginalia keeps apart:
 *
 * - the server's rendered block map (`id`, normalized `text`, heading
 *   context) — the authority for anchors, since the ids in it are what
 *   comment and proposal anchors are matched against;
 * - the block's exact **source** range, recomputed locally from the same
 *   source string the server returned.
 *
 * The source half matters because an edit proposal replaces a block's
 * whole source range: `proposed_text` is spliced in for
 * `source[start..end]`. Without seeing that range verbatim, a proposal
 * is a guess.
 */
export interface DocumentBlock {
  /** 0-based position in document order. */
  index: number;
  id: string;
  kind: string;
  /** Normalized plain text — the string comment quotes are matched against. */
  text: string;
  headingPath: string[];
  sectionIndex: number;
  sectionIndexPath: number[];
  /** Verbatim source for this block, or null if the local walk could not place it. */
  source: string | null;
  start: number | null;
  end: number | null;
  startLine: number | null;
  endLine: number | null;
}

export interface DocumentBlockMap {
  blocks: DocumentBlock[];
  /**
   * Block ids the server rendered but the local source walk could not
   * place. Non-empty means the renderer used here disagrees with the
   * server's — proposals against those blocks are still possible (the
   * server re-derives the range), but their current source is unknown.
   */
  unresolved: string[];
}

const ANCHOR_CONTEXT_LEN = 32;
/** Server-side ceilings; exceeding them is a 400, so clamp instead. */
const MAX_ANCHOR_QUOTE_LENGTH = 60000;

export async function buildBlockMap(doc: DocumentWire): Promise<DocumentBlockMap> {
  const ranges = await locateBlocks(doc.source, doc.format);
  const unresolved: string[] = [];
  const blocks = doc.rendered.blocks.map((block, index) => {
    const range = ranges.get(block.id);
    if (!range) unresolved.push(block.id);
    return toDocumentBlock(block, index, range, doc.source);
  });
  return { blocks, unresolved };
}

async function locateBlocks(
  source: string,
  format: DocumentFormat,
): Promise<Map<string, BlockSourceRange>> {
  if (format === 'asciidoc') {
    // Asciidoctor is a heavy import; only pay for it on asciidoc docs.
    const { locateAllBlocksAsciidoc } = await import('@marginalia/renderer/locate-block-asciidoc');
    return locateAllBlocksAsciidoc(source);
  }
  return locateAllBlocks(source);
}

function toDocumentBlock(
  block: BlockInfoWire,
  index: number,
  range: BlockSourceRange | undefined,
  source: string,
): DocumentBlock {
  return {
    index,
    id: block.id,
    kind: block.kind,
    text: block.text,
    headingPath: block.headingPath ?? [],
    sectionIndex: block.sectionIndex ?? 0,
    sectionIndexPath: block.sectionIndexPath ?? [0],
    source: range ? source.slice(range.start, range.end) : null,
    start: range?.start ?? null,
    end: range?.end ?? null,
    startLine: range ? lineAt(source, range.start) : null,
    endLine: range ? lineAt(source, Math.max(range.start, range.end - 1)) : null,
  };
}

/** 1-based line number of a character offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

export interface AnchorPayload {
  block_id: string;
  end_block_id: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
  heading_path: string[];
  section_index: number;
  section_index_path: number[];
}

/**
 * Build the anchor the API expects, mirroring what the browser produces
 * from a text selection (`apps/web/src/lib/selection.ts`).
 *
 * `quote` and the offsets live in the block's *normalized* text, not its
 * source: the server re-anchors comments by searching that normalized
 * string after an edit. When the requested quote isn't found there —
 * because the caller quoted markdown syntax, say — we fall back to
 * anchoring on the whole block, which is always correct if less precise.
 */
export function buildAnchor(
  block: DocumentBlock,
  quote: string | undefined,
  endBlock?: DocumentBlock | null,
): AnchorPayload {
  const blockText = block.text;
  const requested = quote ? normalizeWhitespace(quote) : '';
  let start = requested ? blockText.indexOf(requested) : -1;
  let effective = requested;
  if (start < 0) {
    effective = blockText;
    start = 0;
  }
  effective = effective.slice(0, MAX_ANCHOR_QUOTE_LENGTH);
  const end = start + effective.length;

  return {
    block_id: block.id,
    end_block_id: endBlock ? endBlock.id : null,
    quote: effective,
    prefix: blockText.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start),
    suffix: blockText.slice(end, Math.min(blockText.length, end + ANCHOR_CONTEXT_LEN)),
    start_offset: start,
    end_offset: end,
    heading_path: block.headingPath,
    section_index: block.sectionIndex,
    section_index_path: block.sectionIndexPath,
  };
}

/** The renderer collapses whitespace before hashing; quotes must match that. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export class BlockLookupError extends Error {}

/**
 * Resolve the caller's idea of "this part of the document" to a block.
 *
 * `block_id` is exact. `anchor_text` is the friendlier path: it matches
 * against both the block's source and its normalized text, so a snippet
 * copied from either representation works. Ambiguity across genuinely
 * different places in the document is an error rather than a silent
 * first-match — picking the wrong one would attach a comment to the
 * wrong paragraph.
 */
export function resolveBlock(
  map: DocumentBlockMap,
  selector: { blockId?: string | undefined; anchorText?: string | undefined },
  label = 'block',
): DocumentBlock {
  if (selector.blockId) {
    const found = map.blocks.find((b) => b.id === selector.blockId);
    if (!found) {
      throw new BlockLookupError(
        `No ${label} with id "${selector.blockId}" in this document. The document may have ` +
          'changed — call list_blocks again for current ids.',
      );
    }
    return found;
  }

  const needle = selector.anchorText?.trim();
  if (!needle) {
    throw new BlockLookupError(`Provide either block_id or anchor_text to select the ${label}.`);
  }

  const matches = innermost(matchBlocks(map.blocks, needle));
  if (matches.length === 0) {
    throw new BlockLookupError(
      `No ${label} contains ${JSON.stringify(clip(needle, 80))}. Use list_blocks with a shorter ` +
        'query to find the right block, then pass its block_id.',
    );
  }
  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 8)
      .map((b) => `  ${b.id}  (${b.kind}, line ${b.startLine ?? '?'}) ${clip(b.text, 60)}`)
      .join('\n');
    throw new BlockLookupError(
      `${matches.length} blocks contain that text, so the target is ambiguous. Pass one of these ` +
        `block_id values instead:\n${candidates}`,
    );
  }
  return matches[0] as DocumentBlock;
}

/** Blocks whose source or normalized text contains `needle`. */
export function matchBlocks(blocks: DocumentBlock[], needle: string): DocumentBlock[] {
  const exact = blocks.filter((b) => b.source?.includes(needle) || b.text.includes(needle));
  if (exact.length > 0) return exact;
  // Second pass for callers who pasted text that spans a soft-wrapped
  // line: compare with whitespace collapsed on both sides.
  const collapsed = normalizeWhitespace(needle);
  if (!collapsed || collapsed === needle) return exact;
  return blocks.filter((b) => b.text.includes(collapsed));
}

/**
 * The block map contains list items and table cells alongside the list
 * or table that encloses them, so a snippet inside one item matches
 * both. Keep only the innermost match — the same preference the browser
 * viewer applies when a selection lands on a sub-block, and the one that
 * makes an edit proposal replace just the item instead of the whole
 * list. Matches in genuinely separate places don't nest, so they survive
 * and are reported as ambiguous.
 */
function innermost(matches: DocumentBlock[]): DocumentBlock[] {
  if (matches.length < 2) return matches;
  return matches.filter((candidate) => {
    const { start, end } = candidate;
    if (start === null || end === null) return true;
    return !matches.some(
      (other) =>
        other !== candidate &&
        other.start !== null &&
        other.end !== null &&
        other.start >= start &&
        other.end <= end &&
        other.end - other.start < end - start,
    );
  });
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
