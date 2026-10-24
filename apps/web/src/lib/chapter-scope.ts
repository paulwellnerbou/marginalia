import type { DocMetaKind } from '@marginalia/renderer/doc-meta';
import type { BlockOccurrence } from '@marginalia/renderer/locate-block';
import type { AnchorSection } from './anchor-target.js';

export interface ChapterScope {
  headingBlockId: string;
  /** Which element carrying `headingBlockId` the chapter starts at, counting from 0. */
  headingCopy: number;
  /** The heading's section, which tells a proposal which copy of the heading it means. */
  section: AnchorSection;
  endBlockId: string;
  blockIds: string[];
  title: string;
  start: number;
  end: number;
  source: string;
  /**
   * Set when the scope is a summary or about region rather than a chapter:
   * `headingBlockId` / `headingCopy` then name the region's first block.
   */
  docMeta?: DocMetaKind;
  /**
   * Source the blocks span beyond `start`/`end`: an AsciiDoc open block's
   * `--` delimiters, kept out of the editor. A proposal replaces whole
   * blocks, so it sends them back around the edited text.
   */
  proposalWrap?: { before: string; after: string };
}

interface RenderedBlock {
  id: string;
  headingLevel: number | null;
}

/** The editor's query for one chapter; the first copy of a heading needs no `copy`. */
export function chapterEditQuery(headingBlockId: string, headingCopy: number): string {
  const chapter = `?chapter=${encodeURIComponent(headingBlockId)}`;
  return headingCopy > 0 ? `${chapter}&copy=${headingCopy}` : chapter;
}

/** `copy` from the editor's query: a non-negative integer, else the first copy. */
export function chapterCopyParam(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Resolve one rendered heading to the source span convention used by edit
 * proposals: heading start through the final source block in its section.
 * Subheadings belong to the chapter; the next heading at the same or a
 * higher level starts the following chapter.
 *
 * Block ids are content hashes, so two chapters with the same title share
 * one heading id; `headingCopy` says which of them is meant.
 */
export function resolveChapterScope(
  source: string,
  renderedHtml: string,
  occurrences: ReadonlyMap<string, readonly BlockOccurrence[]>,
  headingBlockId: string,
  headingCopy = 0,
): ChapterScope | null {
  const parser = new DOMParser();
  const rendered = parser.parseFromString(renderedHtml, 'text/html');
  const blocks = Array.from(rendered.querySelectorAll<HTMLElement>('[data-block]')).flatMap(
    (element): RenderedBlock[] => {
      const id = element.dataset.block;
      if (!id) return [];
      const heading = /^H([1-6])$/.exec(element.tagName);
      return [{ id, headingLevel: heading ? Number(heading[1]) : null }];
    },
  );
  return resolveChapterScopeFromBlocks(source, occurrences, blocks, headingBlockId, headingCopy);
}

/** Exported separately so the boundary rules can be tested without a DOM. */
export function resolveChapterScopeFromBlocks(
  source: string,
  occurrences: ReadonlyMap<string, readonly BlockOccurrence[]>,
  blocks: readonly RenderedBlock[],
  headingBlockId: string,
  headingCopy = 0,
): ChapterScope | null {
  // The n-th rendered element with an id is that id's n-th source
  // occurrence: the renderer and the locator walk the document alike.
  const seen = new Map<string, number>();
  const located = blocks.map((block) => {
    const n = seen.get(block.id) ?? 0;
    seen.set(block.id, n + 1);
    return { ...block, copy: n, range: occurrences.get(block.id)?.[n] };
  });

  const startIndex = located.findIndex(
    (block) => block.id === headingBlockId && block.copy === headingCopy,
  );
  const heading = located[startIndex];
  if (!heading || heading.headingLevel === null) return null;
  const startRange = heading.range;
  if (!startRange || startRange.kind !== 'heading') return null;

  let boundaryIndex = located.length;
  for (let i = startIndex + 1; i < located.length; i += 1) {
    const candidate = located[i];
    if (!candidate) continue;
    if (candidate.headingLevel !== null && candidate.headingLevel <= heading.headingLevel) {
      boundaryIndex = i;
      break;
    }
  }

  const scopedBlocks = located.slice(startIndex, boundaryIndex).filter((block) => block.range);
  const last = scopedBlocks.at(-1);
  const endRange = last?.range;
  if (!last || !endRange || endRange.end < startRange.start) return null;

  return {
    headingBlockId,
    headingCopy,
    section: {
      heading_path: startRange.headingPath,
      section_index: startRange.sectionIndex,
      section_index_path: startRange.sectionIndexPath,
    },
    endBlockId: last.id,
    blockIds: scopedBlocks.map((block) => block.id),
    title: startRange.text,
    start: startRange.start,
    end: endRange.end,
    source: source.slice(startRange.start, endRange.end),
  };
}

const DOC_META_TITLES: Record<DocMetaKind, string> = { summary: 'Summary', about: 'About' };

/** Sub-blocks repeat a slice of their top-level block and take no copy count. */
const SUB_BLOCK_KINDS = new Set(['listItem', 'tableCell']);

interface DocMetaBlock {
  id: string;
  kind: string;
  docMeta?: DocMetaKind | undefined;
}

/**
 * The first summary or about region as an editing scope, shaped like a
 * chapter so the editor saves and proposes it the same way: from the first
 * block inside the markers to the last, markers left out of the editor.
 * Null when the document has no such region, or only its empty markers.
 */
export function resolveDocMetaScope(
  source: string,
  occurrences: ReadonlyMap<string, readonly BlockOccurrence[]>,
  blocks: readonly DocMetaBlock[],
  kind: DocMetaKind,
): ChapterScope | null {
  const seen = new Map<string, number>();
  const inside: Array<{ id: string; copy: number; range: BlockOccurrence }> = [];
  for (const block of blocks) {
    if (SUB_BLOCK_KINDS.has(block.kind)) continue;
    const copy = seen.get(block.id) ?? 0;
    seen.set(block.id, copy + 1);
    if (block.docMeta !== kind) {
      // Only the first region: a second one would pull everything between in.
      if (inside.length > 0) break;
      continue;
    }
    // The Markdown markers are blocks of their own; they stay out of the editor.
    if (block.kind === 'html') continue;
    const range = occurrences.get(block.id)?.[copy];
    if (range) inside.push({ id: block.id, copy, range });
  }
  const first = inside[0];
  const last = inside.at(-1);
  if (!first || !last || last.range.end < first.range.start) return null;
  let start = first.range.start;
  let end = last.range.end;
  let proposalWrap: ChapterScope['proposalWrap'];
  const span = source.slice(start, end);
  const open = /^--\r?\n/.exec(span);
  const close = span.search(/\r?\n--\s*$/);
  if (open && close >= open[0].length) {
    proposalWrap = { before: open[0], after: span.slice(close) };
    end = start + close;
    start += open[0].length;
  } else if (open) {
    return null;
  }
  return {
    headingBlockId: first.id,
    headingCopy: first.copy,
    section: {
      heading_path: first.range.headingPath,
      section_index: first.range.sectionIndex,
      section_index_path: first.range.sectionIndexPath,
    },
    endBlockId: last.id,
    blockIds: inside.map((b) => b.id),
    title: DOC_META_TITLES[kind],
    start,
    end,
    source: source.slice(start, end),
    docMeta: kind,
    ...(proposalWrap ? { proposalWrap } : {}),
  };
}
