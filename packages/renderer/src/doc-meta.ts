import type { RootContent } from 'mdast';

/**
 * A document's summary and about text: the blurb and the author's notes a
 * story platform lists beside a book. They live in the source, so comments,
 * edit proposals and history cover them like any other text, but they are
 * about the book rather than part of it — the viewer folds them away, and
 * statistics and exports leave them out.
 *
 * Markdown marks each region with a pair of HTML comments, which other
 * Markdown renderers simply don't show:
 *
 *     <!-- summary -->
 *     Frankfurt, October 2015. …
 *     <!-- /summary -->
 *
 * AsciiDoc uses an open block with the role: `[.summary]` over `--` … `--`.
 *
 * Only top-level regions count, a region needs its closing marker, and the
 * first region of each kind is the one exports read.
 *
 * Kept free of parser imports so the web app can read the constants
 * without pulling a Markdown pipeline into its bundle; the source-level
 * helpers for exports live in `doc-meta-extract.ts`.
 */
export type DocMetaKind = 'summary' | 'about';

export const DOC_META_KINDS: readonly DocMetaKind[] = ['summary', 'about'];

/** Carried by the element that wraps a region in the rendered HTML. */
export const DOC_META_ATTR = 'data-doc-meta';

/** The limit story platforms put on a summary. Shown to the author, not enforced. */
export const SUMMARY_MAX_CHARACTERS = 1400;

export function isDocMetaKind(v: unknown): v is DocMetaKind {
  return v === 'summary' || v === 'about';
}

const MARKER_RE = /^<!--\s*(\/?)\s*(summary|about)\s*-->$/i;

function markerOf(node: RootContent): { kind: DocMetaKind; close: boolean } | null {
  if (node.type !== 'html') return null;
  const m = MARKER_RE.exec(node.value.trim());
  if (!m) return null;
  return { kind: (m[2] as string).toLowerCase() as DocMetaKind, close: m[1] === '/' };
}

export interface MarkdownDocMetaRegion {
  kind: DocMetaKind;
  /** Index of the opening marker among the root's children. */
  open: number;
  /** Index of the closing marker. Everything strictly between is the region. */
  close: number;
}

/**
 * The regions among a Markdown root's children. A marker that opens while
 * another region is open, or a closing marker without its opener, is left
 * alone as the plain comment it is.
 */
export function findMarkdownDocMetaRegions(
  children: readonly RootContent[],
): MarkdownDocMetaRegion[] {
  const regions: MarkdownDocMetaRegion[] = [];
  let open: { kind: DocMetaKind; index: number } | null = null;
  children.forEach((node, index) => {
    const marker = markerOf(node);
    if (!marker) return;
    if (!open) {
      if (!marker.close) open = { kind: marker.kind, index };
      return;
    }
    if (marker.close && marker.kind === open.kind) {
      regions.push({ kind: open.kind, open: open.index, close: index });
      open = null;
    }
  });
  return regions;
}

/** Region membership by root-child index, for passes that walk the root in order. */
export function markdownDocMetaByIndex(children: readonly RootContent[]): Map<number, DocMetaKind> {
  const byIndex = new Map<number, DocMetaKind>();
  for (const region of findMarkdownDocMetaRegions(children)) {
    for (let i = region.open; i <= region.close; i++) byIndex.set(i, region.kind);
  }
  return byIndex;
}
