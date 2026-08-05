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

/**
 * A heading and everything under it, down to the next heading at the
 * same or shallower nesting. The unit a reader thinks in — "chapter
 * three" — and the unit worth fetching on its own, since pulling a whole
 * book's source to look at one chapter is the expensive mistake.
 */
export interface DocumentSection {
  /** Position among all sections, document order. */
  index: number;
  /** The heading's own text. */
  heading: string;
  /** Enclosing headings, outermost first, including this one. */
  path: string[];
  /** Nesting depth (1 for a top-level heading). Not the markdown level. */
  depth: number;
  /** Slug for `#fragment` links, when the heading list lines up with the block list. */
  slug: string | null;
  /** Verbatim source of the whole section, heading line included. */
  source: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** Index range into `DocumentBlockMap.blocks`, `[from, to)`. */
  fromBlock: number;
  toBlock: number;
}

export interface DocumentBlockMap {
  blocks: DocumentBlock[];
  sections: DocumentSection[];
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
  // One forward scan for the whole document, then a binary search per
  // lookup. Counting newlines from the start for each of a book's few
  // thousand blocks is quadratic in the source length, and every tool
  // call that loads a document pays it.
  const lines = lineStarts(doc.source);
  const unresolved: string[] = [];
  const blocks = doc.rendered.blocks.map((block, index) => {
    const range = ranges.get(block.id);
    if (!range) unresolved.push(block.id);
    return toDocumentBlock(block, index, range, doc.source, lines);
  });
  return { blocks, sections: buildSections(blocks, doc, lines), unresolved };
}

/**
 * Slice the block list into sections.
 *
 * A section runs from its heading block to just before the next heading
 * at the same or shallower depth, so the source span is a plain
 * `slice(heading.start, nextHeading.start)` — no need to reason about
 * where sub-blocks end.
 *
 * Slugs come from `rendered.anchors`, which lists headings flat in
 * document order, the same order heading blocks appear in. They are
 * zipped by position and only when the two lists are the same length:
 * an off-by-one would attach the wrong `#fragment` to every heading,
 * and a missing slug is far cheaper than a wrong one.
 */
function buildSections(
  blocks: DocumentBlock[],
  doc: DocumentWire,
  lines: number[],
): DocumentSection[] {
  const headings = blocks.filter((b) => b.kind === 'heading' && b.start !== null);
  const anchors = doc.rendered.anchors ?? [];
  const slugs = anchors.length === headings.length ? anchors.map((a) => a.id) : null;

  return headings.map((heading, i) => {
    const depth = Math.max(1, heading.headingPath.length);
    const next = headings.slice(i + 1).find((h) => Math.max(1, h.headingPath.length) <= depth);
    const end = next ? (next.start as number) : doc.source.length;
    const start = heading.start as number;
    const source = doc.source.slice(start, end).replace(/\s+$/u, '');
    return {
      index: i,
      heading: heading.text,
      path: heading.headingPath,
      depth,
      slug: slugs?.[i] ?? null,
      source,
      start,
      end: start + source.length,
      startLine: heading.startLine as number,
      endLine: lineAt(lines, Math.max(start, start + source.length - 1)),
      fromBlock: heading.index,
      toBlock: next ? next.index : blocks.length,
    };
  });
}

/**
 * Find the section the caller means. Accepts the heading text, a
 * `#slug`, or a `Parent > Child` path; an exact heading or slug match
 * wins outright, otherwise a substring must be unique. Ambiguity is an
 * error listing the candidates — silently picking one chapter of three
 * that share a word would waste the whole point of asking for one.
 */
export function resolveSection(map: DocumentBlockMap, query: string): DocumentSection {
  const raw = query.trim().replace(/^#/, '');
  const needle = raw.toLowerCase();
  if (!needle) throw new BlockLookupError('Name the section to read.');
  if (map.sections.length === 0) {
    throw new BlockLookupError('This document has no headings, so it has no sections.');
  }

  const exact = map.sections.filter(
    (s) => s.heading.toLowerCase() === needle || s.slug?.toLowerCase() === needle,
  );
  const matches =
    exact.length > 0
      ? exact
      : map.sections.filter(
          (s) =>
            s.heading.toLowerCase().includes(needle) ||
            s.path.join(' > ').toLowerCase().includes(needle),
        );

  if (matches.length === 0) {
    throw new BlockLookupError(
      `No section matches ${JSON.stringify(clip(raw, 60))}. Available sections:\n` +
        map.sections.map((s) => `  ${'  '.repeat(s.depth - 1)}${s.heading}`).join('\n'),
    );
  }
  if (matches.length > 1) {
    throw new BlockLookupError(
      `${matches.length} sections match ${JSON.stringify(clip(raw, 60))}. Name one exactly, or ` +
        `use its path:\n${matches.map((s) => `  ${s.path.join(' > ')}`).join('\n')}`,
    );
  }
  return matches[0] as DocumentSection;
}

/** Does this block sit inside the section (including its subsections)? */
export function sectionContains(section: DocumentSection, block: DocumentBlock): boolean {
  return block.index >= section.fromBlock && block.index < section.toBlock;
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
  lines: number[],
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
    startLine: range ? lineAt(lines, range.start) : null,
    endLine: range ? lineAt(lines, Math.max(range.start, range.end - 1)) : null,
  };
}

/** Character offset at which each line starts, ascending. Index 0 is line 1. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number of a character offset, by binary search over `lineStarts`. */
function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
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
