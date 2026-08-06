/**
 * Public types produced and consumed by the renderer.
 *
 * The shape is stable — viewers, the TOC, and comment-anchoring all depend on
 * it, so changing it is a breaking change.
 */

export interface RenderOptions {
  /** Absolute/relative path used to resolve asset references. Optional. */
  baseDir?: string;

  /** Syntax highlighting — pick two Shiki themes for light/dark CSS vars. */
  highlight?: {
    light?: string;
    dark?: string;
  };

  /**
   * Mermaid handling. 'client' (default) leaves `<div class="mermaid">`
   * blocks for the browser runtime. 'svg' pre-renders to inline SVG (used
   * by export — not implemented yet; falls back to 'client' for now).
   */
  mermaid?: 'client' | 'svg';

  /** If true, throw on broken in-document references. Default: false. */
  strictRefs?: boolean;
}

export interface Anchor {
  /** Heading level 1..6 */
  level: number;
  /** The heading's rendered text (plain) */
  text: string;
  /** Stable Unicode-safe slug used as the element id */
  id: string;
}

export interface TocNode extends Anchor {
  children: TocNode[];
}

export interface AssetRef {
  /** The exact URL/path as it appeared in the source */
  src: string;
  /** Where this reference lives in the source, 1-based. */
  line?: number;
  /** alt text of the image, or null if not an image */
  alt: string | null;
  kind: 'image' | 'link';
}

export interface MermaidBlock {
  /** Sequential index within the document */
  index: number;
  /** Raw mermaid source */
  source: string;
}

export interface BlockInfo {
  /** Content-hash ID, also written to the element as data-block */
  id: string;
  /** Type of the block (mdast node type) */
  kind: string;
  /**
   * Normalized plain text content — used for comment anchoring.
   *
   * NOT the string `id` was hashed from, and re-hashing it will not
   * reproduce `id`. The id is fingerprinted from the source AST so it can be
   * recomputed without rendering (see `locateAllBlocks`); this is read back
   * off the rendered tree so it matches what the browser will show, which is
   * where the quotes anchoring searches for come from. See
   * `plugins/block-text.ts`.
   *
   * With one exception, which is not safe to assume away. Three kinds reach
   * this map with no element in the output carrying their id, each losing it
   * somewhere different: a `code` block's id rides on the `<code>` element
   * until Shiki rewrites it away, an `html` block never has one to begin with
   * (raw HTML becomes a hast `raw` string, which has nowhere to keep
   * properties), and a `footnoteDefinition` is rebuilt from scratch inside a
   * generated `<section class="footnotes">`.
   *
   * There is nothing to read those off, so they keep the source-AST text and
   * can differ from what the browser shows. They are also the entries the
   * client cannot resolve to an element at all, so treat a match against one
   * as unpaintable rather than as DOM text.
   */
  text: string;
  /**
   * Enclosing heading hierarchy (normalized heading texts, outermost first).
   * For a heading block the stack includes the heading itself. Empty when
   * the block precedes any heading.
   *
   * Used by comment re-anchoring to disambiguate when the same quoted text
   * appears in multiple sections.
   */
  headingPath: string[];
  /**
   * 0-based position of this block among the blocks that share the same
   * headingPath. Together with headingPath this pins a comment to a specific
   * section/offset so a verbatim quote elsewhere in the doc won't win.
   */
  sectionIndex: number;
  /**
   * 0-based position of this block within each ancestor section, from the
   * document root down to the innermost section. Length is
   * `headingPath.length + 1`:
   *   [0] — position among all blocks in the whole doc (root-level ordinal)
   *   [k] — position within the section rooted at headingPath[0..k-1]
   *   [last] — same as `sectionIndex`
   *
   * Used by re-anchoring as a graceful fallback: if the deepest heading is
   * renamed or removed, we can still match "n-th block under the nearest
   * surviving heading".
   */
  sectionIndexPath: number[];
}

/** Ordered list of top-level blocks, by document order. */
export type BlockMap = BlockInfo[];

export type WarningKind = 'broken-ref' | 'missing-alt' | 'sanitized-element' | 'unknown-language';

export interface Warning {
  kind: WarningKind;
  message: string;
  line?: number;
}

export interface RenderResult {
  html: string;
  anchors: Anchor[];
  toc: TocNode[];
  assets: AssetRef[];
  mermaid: MermaidBlock[];
  blocks: BlockMap;
  warnings: Warning[];
  /** Parsed frontmatter (YAML). Empty object if none. */
  frontmatter: Record<string, unknown>;
}
