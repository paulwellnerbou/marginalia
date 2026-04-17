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
  /** Normalized plain text content — used for comment anchoring */
  text: string;
}

/** Ordered list of top-level blocks, by document order. */
export type BlockMap = BlockInfo[];

export type WarningKind =
  | 'broken-ref'
  | 'missing-alt'
  | 'sanitized-element'
  | 'unknown-language';

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
