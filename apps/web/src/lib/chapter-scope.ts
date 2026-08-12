import type { BlockSourceRange } from '@marginalia/renderer/locate-block';

export interface ChapterScope {
  headingBlockId: string;
  endBlockId: string;
  blockIds: string[];
  title: string;
  start: number;
  end: number;
  source: string;
}

interface RenderedBlock {
  id: string;
  headingLevel: number | null;
}

/**
 * Resolve one rendered heading to the source span convention used by edit
 * proposals: heading start through the final source block in its section.
 * Subheadings belong to the chapter; the next heading at the same or a
 * higher level starts the following chapter.
 */
export function resolveChapterScope(
  source: string,
  renderedHtml: string,
  ranges: ReadonlyMap<string, BlockSourceRange>,
  headingBlockId: string,
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
  return resolveChapterScopeFromBlocks(source, ranges, blocks, headingBlockId);
}

/** Exported separately so the boundary rules can be tested without a DOM. */
export function resolveChapterScopeFromBlocks(
  source: string,
  ranges: ReadonlyMap<string, BlockSourceRange>,
  blocks: readonly RenderedBlock[],
  headingBlockId: string,
): ChapterScope | null {
  const startIndex = blocks.findIndex((block) => block.id === headingBlockId);
  if (startIndex < 0) return null;

  const heading = blocks[startIndex];
  if (!heading) return null;
  if (heading.headingLevel === null) return null;
  const startRange = ranges.get(headingBlockId);
  if (!startRange || startRange.kind !== 'heading') return null;

  let boundaryIndex = blocks.length;
  for (let i = startIndex + 1; i < blocks.length; i += 1) {
    const candidate = blocks[i];
    if (!candidate) continue;
    if (candidate.headingLevel !== null && candidate.headingLevel <= heading.headingLevel) {
      boundaryIndex = i;
      break;
    }
  }

  const scopedBlocks = blocks
    .slice(startIndex, boundaryIndex)
    .filter((block) => ranges.has(block.id));
  const last = scopedBlocks.at(-1);
  if (!last) return null;
  const endRange = ranges.get(last.id);
  if (!endRange || endRange.end < startRange.start) return null;

  return {
    headingBlockId,
    endBlockId: last.id,
    blockIds: scopedBlocks.map((block) => block.id),
    title: startRange.text,
    start: startRange.start,
    end: endRange.end,
    source: source.slice(startRange.start, endRange.end),
  };
}
