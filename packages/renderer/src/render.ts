import type { Root as HastRoot } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { remarkAssetCollector } from './plugins/asset-collector.js';
import { remarkBlockIds } from './plugins/block-ids.js';
import { remarkExtractFrontmatter } from './plugins/frontmatter.js';
import { preprocessGridTables } from './plugins/grid-tables.js';
import { rehypeHeadingAnchors } from './plugins/heading-anchors.js';
import { remarkMermaid } from './plugins/mermaid.js';
import { sanitizeSchema } from './plugins/sanitize-schema.js';
import { rehypeShikiHighlight } from './plugins/shiki.js';
import { remarkSlugger } from './plugins/slugger.js';
import { remarkTocMarker } from './plugins/toc-marker.js';
import { renderAsciidoc } from './render-asciidoc.js';
import { buildToc } from './toc.js';
import type {
  Anchor,
  AssetRef,
  BlockMap,
  MermaidBlock,
  RenderOptions,
  RenderResult,
  Warning,
} from './types.js';

/** Document source flavours supported by the renderer. */
export type DocumentFormat = 'markdown' | 'asciidoc';

export function isDocumentFormat(v: unknown): v is DocumentFormat {
  return v === 'markdown' || v === 'asciidoc';
}

/**
 * Format-agnostic entry point. Delegates to the markdown or asciidoc
 * pipeline; both return the same RenderResult shape, so downstream
 * consumers (comment anchoring, TOC, search) don't care which path ran.
 */
export function renderDocument(
  source: string,
  format: DocumentFormat,
  options: RenderOptions = {},
): Promise<RenderResult> {
  return format === 'asciidoc' ? renderAsciidoc(source, options) : render(source, options);
}

interface RenderData {
  anchors?: Anchor[];
  assets?: AssetRef[];
  mermaid?: MermaidBlock[];
  blocks?: BlockMap;
  warnings?: Warning[];
  frontmatter?: Record<string, unknown>;
}

export async function render(markdown: string, options: RenderOptions = {}): Promise<RenderResult> {
  const preprocessed = await preprocessGridTables(markdown, {
    renderCell: (cellMd) => renderCell(cellMd, options),
  });

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkExtractFrontmatter)
    .use(remarkSlugger)
    .use(remarkBlockIds)
    .use(remarkMermaid, { mode: options.mermaid ?? 'client' })
    .use(remarkTocMarker)
    .use(remarkAssetCollector)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeHeadingAnchors)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeShikiHighlight, options.highlight ?? {})
    .use(rehypeStringify, { allowDangerousHtml: false });

  const file = await processor.process(preprocessed);
  const data = file.data as RenderData;

  const anchors = data.anchors ?? [];
  const warnings = data.warnings ?? [];

  return {
    html: String(file),
    anchors,
    toc: buildToc(anchors),
    assets: data.assets ?? [],
    mermaid: data.mermaid ?? [],
    blocks: data.blocks ?? [],
    warnings,
    frontmatter: data.frontmatter ?? {},
  };
}

// Exported for tests that want intermediate ASTs.
export type { HastRoot, MdastRoot };

/**
 * Minimal sub-pipeline used to render a single grid-table cell to HTML.
 * Deliberately drops slugger / block-ids / mermaid / asset-collector since
 * those only make sense at document level.
 */
async function renderCell(markdown: string, options: RenderOptions): Promise<string> {
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeShikiHighlight, options.highlight ?? {})
    .use(rehypeStringify, { allowDangerousHtml: false });

  const file = await proc.process(markdown);
  const html = String(file).trim();
  // Unwrap a single <p>…</p> so simple cells render as inline content —
  // matches the feel of GFM pipe tables.
  const m = html.match(/^<p>([\s\S]*)<\/p>$/);
  if (m && !m[1]!.includes('<p>') && !m[1]!.includes('<div>')) return m[1]!;
  return html;
}
