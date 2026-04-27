/**
 * DOCX export.
 *
 * Runs the markdown pipeline up to HAST (reusing the shared rehype
 * processor, including syntax highlighting), then walks the HAST to
 * emit a `docx.Document`. The walker is theme-token-aware so the
 * produced file typographically matches the selected viewer theme —
 * fonts, font sizes, color accent, heading hierarchy, table styling,
 * blockquote treatment, etc.
 *
 * Coverage:
 * - M2: paragraph, heading, inline formatting (strong/em/code/strike),
 *   links (external + internal to bookmarks), ordered/unordered lists
 *   with nesting, tables (GFM), blockquote, horizontal rule, code
 *   blocks with Shiki per-token colors carried through.
 * - M3a: bookmarks on headings (slug id), internal hash-links resolve
 *   to those bookmarks so TOC-style navigation works inside Word.
 * - M3b: native Word TOC field, prepended when the doc has ≥ 2
 *   headings (configurable via `DocxExportOptions.includeToc`).
 * - M3c: GFM footnotes lifted into native Word footnotes — references
 *   become `FootnoteReferenceRun`s, bodies land in `footnotes.xml`.
 * - M4a: images embed as real `ImageRun`s when a `resolveAsset`
 *   callback yields bytes; `data:` URLs decode inline without a
 *   callback. Unsupported or unresolvable images fall back to a muted
 *   italic placeholder so the doc still reads.
 * - M4b: mermaid blocks rasterize to PNG when the caller wires up
 *   `resolveMermaid` (the server route shells out to the native Rust
 *   `mmdr` CLI). Resolution runs with bounded parallelism — see
 *   `mermaidConcurrency`. When the resolver is absent or returns
 *   null/throws, the block falls back to the labeled-code-block
 *   stopgap so the diagram source is still readable.
 * - M5: BCP-47 language tag + `<w:bidi/>` for RTL frontmatter.
 */

import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { unified } from 'unified';
import type { Element, Root as HastRoot, Node as HastNode, Parent, Text } from 'hast';

import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  convertMillimetersToTwip,
  type FileChild,
  type IRunOptions,
  type ISectionOptions,
  type ParagraphChild,
} from 'docx';
import { imageSize } from 'image-size';
import { visit } from 'unist-util-visit';

import { getThemeTokens, type ThemeTokens } from '@marginalia/themes/tokens';

import { remarkExtractFrontmatter } from './plugins/frontmatter.js';
import { remarkSlugger } from './plugins/slugger.js';
import { remarkBlockIds } from './plugins/block-ids.js';
import { remarkMermaid } from './plugins/mermaid.js';
import { remarkAssetCollector } from './plugins/asset-collector.js';
import { remarkTocMarker, TOC_MARKER_CLASSNAME } from './plugins/toc-marker.js';
import { rehypeShikiHighlight } from './plugins/shiki.js';
import { rehypeHeadingAnchors } from './plugins/heading-anchors.js';
import { sanitizeSchema } from './plugins/sanitize-schema.js';
import { preprocessGridTables } from './plugins/grid-tables.js';
import { renderAsciidoc } from './render-asciidoc.js';
import type { DocumentFormat } from './render.js';
import type { RenderOptions } from './types.js';

/**
 * DOCX-specific sanitize schema. Same as the viewer schema except
 * `<img src>` is allowed to carry `data:` URLs — the exporter decodes
 * them to bytes and embeds them as a real image part, never evaluates
 * them as HTML, so the usual XSS rationale for stripping data: doesn't
 * apply on this path.
 */
const sanitizeSchemaForDocx = {
  ...sanitizeSchema,
  protocols: {
    ...(sanitizeSchema.protocols ?? {}),
    src: [...(sanitizeSchema.protocols?.src ?? ['http', 'https']), 'data'],
  },
};

// -- Public API ---------------------------------------------------------

export interface ResolvedAsset {
  /** Raw image bytes. */
  readonly bytes: Uint8Array;
  /** MIME type; used to pick the DOCX image type. */
  readonly mime: string;
  /**
   * Intended display dimensions in CSS pixels (96 DPI). Optional —
   * when omitted, the exporter probes the bytes and uses the raw
   * pixel count as the display size (correct for 1× raster
   * sources like user-uploaded images).
   *
   * Use this to ship a HIGH-RESOLUTION raster while telling Word to
   * display at the smaller natural size: the chromium mermaid
   * resolver renders at deviceScaleFactor=4 so the PNG holds 4× the
   * pixels, but `width`/`height` here carry the original CSS-pixel
   * size of the diagram. Word then displays at the natural size and
   * has 4× the pixels to draw on at high zoom or print resolution.
   *
   * Without this, embedding a 4×-resolution PNG would scale the
   * diagram up by 4× visually, which is the opposite of what we
   * want.
   */
  readonly width?: number;
  readonly height?: number;
}

export interface DocxExportOptions {
  /**
   * Which theme to render the DOCX in. Matches theme ids from
   * `@marginalia/themes` (and the `BUILT_IN_THEMES` list in the web app).
   * Unknown/undefined → falls back to 'default' (same as the viewer).
   */
  theme?: string;

  /** Document title stored in DOCX core properties (File > Info). */
  title?: string;

  /** DOCX `creator` / `lastModifiedBy` — typically the document owner. */
  author?: string;

  /** Source format. Defaults to markdown. */
  format?: DocumentFormat;

  /** Syntax-highlighting theme pair passed through to Shiki. */
  highlight?: RenderOptions['highlight'];

  /**
   * Resolves an `<img>` src (as it appears in the markdown source —
   * either a relative asset ref like `logo.png` or an absolute URL) to
   * the image's bytes and MIME type for embedding. Data URLs are
   * decoded inline and never hit this resolver.
   *
   * Return `null` (or throw — the exporter catches and swallows the
   * error rather than propagating it) to skip: the image renders as a
   * muted italic `[image: alt]` placeholder so the doc still reads
   * without the asset. The server wires this up against its
   * per-document asset store; CLI/library consumers can supply their
   * own (e.g. read from disk).
   */
  resolveAsset?: (src: string) => Promise<ResolvedAsset | null>;

  /**
   * Rasterize a mermaid block's source to image bytes for embedding.
   * The exporter calls this once per mermaid block (with bounded
   * parallelism — see `mermaidConcurrency`) before walking the HAST.
   * Return `null` (or throw — caught and swallowed) to fall back to
   * the labeled-code-block stopgap so the diagram source is still
   * readable in the doc.
   *
   * `index` is the 0-based mermaid block index recorded by
   * `remarkMermaid` — useful for caching or logging which diagram
   * failed without re-extracting the source.
   *
   * The server route wires this against the native `mmdr` Rust CLI;
   * other callers (CLI / library) can supply their own resolver or
   * leave it unset to get the labeled-code-block fallback.
   */
  resolveMermaid?: (source: string, index: number) => Promise<ResolvedAsset | null>;

  /**
   * Maximum number of mermaid blocks to resolve concurrently.
   * Default: 4. Each `resolveMermaid` call may spawn a subprocess
   * (the server's mmdr path does), so unbounded `Promise.all` over
   * a 20-diagram doc would fan out into 20 simultaneous renderer
   * processes and starve the host. Bound it. Set higher for cheap
   * resolvers (in-memory cache) or lower if the host is constrained.
   * Values < 1 are clamped to 1.
   */
  mermaidConcurrency?: number;

  /**
   * Include a native Word Table of Contents field at the top of the
   * document. The TOC is populated by Word when the user opens the
   * file (the export marks it dirty, so Word prompts to update on
   * first open).
   *
   * Default: auto — included iff the document has ≥ 2 headings.
   * Set explicitly `true`/`false` to force on/off.
   */
  includeToc?: boolean | 'auto';

  /** Heading shown above the TOC. Default: "Contents". Empty string = no heading. */
  tocLabel?: string;

  /**
   * Document language hint (BCP-47 code, e.g. `ar`, `he`, `de-DE`).
   * Overrides any `lang:` value in the document's YAML frontmatter.
   * Used to set paragraph direction and complex-script language tags
   * so RTL scripts render correctly in Word.
   */
  language?: string;

  /**
   * Paper size override. Most callers should leave this unset and let
   * the selected theme drive page geometry — every built-in theme
   * ships with sensible A4 / A5 / B5 / Letter defaults. Set when you
   * need a specific size regardless of theme (e.g. "all exports go
   * to Letter for our US office").
   */
  pageSize?: 'A4' | 'Letter' | 'A5' | 'B5';
}

/**
 * Render a markdown/asciidoc source string to a DOCX buffer styled to
 * the given theme. Everything is server-safe (no DOM, no browser APIs).
 */
export async function exportDocx(
  source: string,
  options: DocxExportOptions = {},
): Promise<Buffer> {
  const tokens = getThemeTokens(options.theme);
  const { hast, frontmatter } = await sourceToHast(
    source,
    options.format ?? 'markdown',
    {
      ...(options.highlight !== undefined ? { highlight: options.highlight } : {}),
    },
  );

  // Resolve the document's language. Explicit `options.language` wins;
  // otherwise read `lang:` (or `language:`) from YAML frontmatter so
  // writers can set direction without touching any UI.
  const language = resolveLanguage(options.language, frontmatter);
  const rtl = isRtlLanguage(language);
  // Resolve images up-front in parallel so the HAST walker can stay
  // synchronous. docx construction is CPU-bound and sync; doing the
  // async I/O here keeps the walker tidy.
  //
  // Mermaid blocks resolve through the same machinery: each
  // `<div class="mermaid" data-mermaid-index="N">` is handed to
  // `options.resolveMermaid()` and the resulting bytes are probed
  // exactly like an `<img>` (same image-size + ImageRun path), keyed
  // by the numeric index from `remarkMermaid`.
  const [images, mermaidImages] = await Promise.all([
    resolveAllImages(hast, options.resolveAsset),
    resolveAllMermaid(hast, options.resolveMermaid, options.mermaidConcurrency),
  ]);

  // Pull GFM footnotes out of the body: build their DOCX paragraphs,
  // assign each a numeric id, and remove the `<section>` so it won't
  // appear inline. The walker later turns `<sup>` refs into
  // `FootnoteReferenceRun`s pointed at those ids.
  const effectivePageSize = options.pageSize ?? tokens.page.size;
  const ctxWithoutFootnotes: BuildCtx = {
    tokens,
    images,
    mermaidImages,
    pageWidthPx: contentWidthPx(effectivePageSize, tokens.page.marginPt),
    footnoteIds: new Map(),
  };
  const footnotes = extractFootnotes(hast, ctxWithoutFootnotes);
  const ctx: BuildCtx = { ...ctxWithoutFootnotes, footnoteIds: footnotes.ids };

  // TOC decision tree:
  //  1. Any `[TOC]` / `[[_TOC_]]` marker wins. We emit at the first
  //     marker's position and silently drop the rest.
  //  2. Otherwise, `auto` (and undefined) emit a TOC iff the doc has
  //     ≥ 2 headings, sited after the leading heading if any.
  //  3. `includeToc: false` suppresses everything — markers become
  //     no-ops, no auto emission.
  const hasMarker = hasTocMarker(hast);
  const shouldIncludeToc =
    options.includeToc === true ||
    ((options.includeToc === 'auto' || options.includeToc === undefined) &&
      (hasMarker || countHeadings(hast) >= 2));
  const tocBlocks = shouldIncludeToc
    ? buildTocBlocks(options.tocLabel ?? 'Contents', tokens)
    : [];

  // If a marker drives placement, pendingToc carries the blocks to
  // emit when the walker first hits a marker element. After the
  // walker consumes it, subsequent markers become no-ops.
  const walkerCtx: BuildCtx = hasMarker
    ? {
        ...ctx,
        pendingToc: shouldIncludeToc ? { blocks: [...tocBlocks], consumed: false } : null,
      }
    : ctx;

  // Without a marker, fall back to the existing "insert after the
  // leading heading" heuristic (or prepend if the doc has no
  // leading heading at all).
  const leadingHeadingIdx = hasMarker ? -1 : indexOfLeadingHeading(hast);
  const body = hastToDocxChildren(hast, walkerCtx, {
    injectAfterTopLevelIndex: leadingHeadingIdx,
    injectedBlocks: hasMarker ? [] : tocBlocks,
  });
  const blocks: FileChild[] =
    !hasMarker && shouldIncludeToc && leadingHeadingIdx < 0
      ? [...tocBlocks, ...body]
      : body;

  const doc = buildDocument(blocks, tokens, options, footnotes.content, {
    language,
    rtl,
  });
  return Packer.toBuffer(doc);
}

// -- Language / RTL -----------------------------------------------------

/** BCP-47 primary subtags that render right-to-left. */
const RTL_LANGS = new Set([
  'ar', // Arabic
  'arc', // Aramaic
  'az', // Azerbaijani (when in Arabic script — best-effort)
  'dv', // Divehi
  'fa', // Persian
  'he', // Hebrew
  'iw', // Hebrew (deprecated tag)
  'ji', // Yiddish (deprecated)
  'ku', // Kurdish (some scripts)
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'ur', // Urdu
  'yi', // Yiddish
]);

function isRtlLanguage(lang: string | null): boolean {
  if (!lang) return false;
  const primary = lang.toLowerCase().split(/[-_]/)[0] ?? '';
  return RTL_LANGS.has(primary);
}

function resolveLanguage(
  override: string | undefined,
  frontmatter: Record<string, unknown>,
): string | null {
  if (typeof override === 'string' && override.length > 0) return override;
  const candidates = [frontmatter.lang, frontmatter.language, frontmatter.locale];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * Count top-level headings (h1–h6) in the HAST. Used by `includeToc:
 * 'auto'` to decide whether a TOC is worth emitting.
 */
function countHeadings(root: HastRoot): number {
  let n = 0;
  visit(root, 'element', (node: Element) => {
    if (/^h[1-6]$/.test(node.tagName)) n++;
  });
  return n;
}

/**
 * Emit a TOC block: an optional "Contents" heading followed by Word's
 * native TableOfContents field. We set `beginDirty: true` (via the
 * options object's untyped slot) so Word prompts the user to
 * auto-populate the TOC on first open — otherwise they'd see an empty
 * placeholder until they press F9 themselves.
 */
function buildTocBlocks(label: string, _tokens: ThemeTokens): FileChild[] {
  const out: FileChild[] = [];
  if (label) {
    // Use the custom `TocHeading` style — NOT `Heading1`. Two reasons:
    //   1. Visually, "Contents" should be less dominant than the
    //      document's own H1 title.
    //   2. The TOC field's `headingStyleRange: '1-6'` would otherwise
    //      self-include "Contents" as an entry in its own list.
    out.push(
      new Paragraph({
        style: 'TocHeading',
        children: [new TextRun({ text: label })],
      }),
    );
  }
  // `hyperlink: true` makes entries clickable in Word.
  // `headingStyleRange: '1-6'` pulls all heading levels into the TOC.
  // `beginDirty: true` marks the TOC field dirty so Word prompts to
  // auto-populate on first open (otherwise the user sees an empty
  // placeholder until they press F9).
  //
  // The first argument to `TableOfContents` is the SDT alias — an
  // internal accessibility/navigation tag on the content control,
  // not visible body text. We pass a neutral identifier so that
  // when the caller opts out of the user-visible heading (`tocLabel:
  // ''`) we don't end up advertising "Table of Contents" anywhere.
  out.push(
    new TableOfContents(label || 'marginalia-toc', {
      hyperlink: true,
      headingStyleRange: '1-6',
      beginDirty: true,
    }),
  );
  // Trailing blank paragraph so the first heading after the TOC
  // doesn't butt right up against it.
  out.push(new Paragraph({ children: [] }));
  return out;
}

// -- Pipeline: source → HAST -------------------------------------------

/**
 * Runs the same pipeline as `render()` but stops at HAST (before
 * stringify) so the walker can see the tree Shiki produced. For
 * AsciiDoc we don't have a native unified pipeline — we re-parse the
 * renderer's HTML output, which is acceptable because AsciiDoc's
 * output is already sanitized.
 *
 * Returns the HAST and the extracted frontmatter; the exporter uses
 * the latter for language/direction detection.
 */
async function sourceToHast(
  source: string,
  format: DocumentFormat,
  options: Pick<RenderOptions, 'highlight'>,
): Promise<{ hast: HastRoot; frontmatter: Record<string, unknown> }> {
  if (format === 'asciidoc') {
    const { html, frontmatter } = await renderAsciidoc(source, options);
    const hast = unified()
      .use(rehypeParse, { fragment: true })
      .parse(html) as HastRoot;
    return { hast, frontmatter };
  }

  const preprocessed = await preprocessGridTables(source, {
    renderCell: (cellMd) => renderCellForDocx(cellMd, options),
  });

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkExtractFrontmatter)
    .use(remarkSlugger)
    .use(remarkBlockIds)
    .use(remarkMermaid, { mode: 'client' })
    .use(remarkTocMarker)
    .use(remarkAssetCollector)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeHeadingAnchors)
    .use(rehypeSanitize, sanitizeSchemaForDocx)
    .use(rehypeShikiHighlight, options.highlight ?? {});

  const mdast = processor.parse(preprocessed);
  const hast = (await processor.run(mdast)) as HastRoot;
  // `remarkExtractFrontmatter` writes to `file.data.frontmatter`
  // during `.process()`, but our pipeline doesn't stringify (no
  // compiler) so we read frontmatter out-of-band from the source
  // text. This duplicates a few lines of YAML parsing logic with the
  // plugin, but it avoids pulling in `vfile` as a direct dep.
  const frontmatter = parseFrontmatter(preprocessed);
  return { hast, frontmatter };
}

/**
 * Render a single grid-table cell's markdown to HTML for the DOCX
 * path. Mirrors `render.ts`'s sub-pipeline: parse → rehype with
 * raw-HTML pass-through → sanitize (DOCX flavour, so `data:` image
 * URLs survive) → shiki highlighting → stringify. Returning HTML
 * lets the grid-tables preprocessor splice it into the `<td>`, and
 * the DOCX walker later turns each cell into real paragraph runs.
 *
 * Returning `''` here — as this code did before — silently emptied
 * every grid-table cell on the export path.
 */
async function renderCellForDocx(
  markdown: string,
  renderOptions: Pick<DocxExportOptions, 'highlight'>,
): Promise<string> {
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchemaForDocx)
    .use(rehypeShikiHighlight, renderOptions.highlight ?? {})
    .use(rehypeStringify, { allowDangerousHtml: false });
  const file = await proc.process(markdown);
  const html = String(file).trim();
  // Unwrap a single `<p>…</p>` so simple cells render as inline
  // content — matches how GFM pipe tables look, and avoids an extra
  // Paragraph per cell in the DOCX walker.
  const m = html.match(/^<p>([\s\S]*)<\/p>$/);
  if (m && !m[1]!.includes('<p>') && !m[1]!.includes('<div>')) return m[1]!;
  return html;
}

/**
 * Minimal YAML frontmatter extraction — just enough to read scalar
 * keys like `lang:` / `language:`. Recognises the usual `---…---`
 * delimiters at the top of the document. Anything more complex
 * (flow-style mappings, anchors, multi-line strings) is out of scope;
 * callers fall back to `options.language` for those cases.
 */
function parseFrontmatter(source: string): Record<string, unknown> {
  if (!source.startsWith('---')) return {};
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return {};
  const body = m[1] ?? '';
  const out: Record<string, unknown> = {};
  for (const line of body.split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!keyValue) continue;
    let value: string = (keyValue[2] ?? '').trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[keyValue[1]!] = value;
  }
  return out;
}

// -- Unit helpers -------------------------------------------------------

/** Points → half-points (docx's unit for font size / line spacing). */
const pt2hp = (pt: number): number => Math.round(pt * 2);

/** Points → twips (1/20pt). DOCX spacing units. */
const pt2twip = (pt: number): number => Math.round(pt * 20);

/** Shared left indent used by the Blockquote style. */
const BLOCKQUOTE_INDENT_PT = 18;
/** Word body copy reads too airy above 1.5; keep DOCX body/list spacing fixed. */
const DOCX_MAX_BODY_LINE_HEIGHT = 1.5;
const DOCX_BODY_LINE_SPACING = Math.round(DOCX_MAX_BODY_LINE_HEIGHT * 240);
const DOCX_LIST_ITEM_SPACING_PT = 3;

/** Strip leading '#' and validate — defensive; we control token hex strings. */
const hex = (c: string): string => c.replace(/^#/, '').toLowerCase();

/**
 * Usable content width (in CSS px at 96 DPI) for the current page. We
 * use this to scale images down so they don't blow past the margins.
 * docx's `ImageRun` transformation is in pixels.
 */
function contentWidthPx(
  size: ThemeTokens['page']['size'],
  marginPt: number,
): number {
  // A4 ≈ 595pt, Letter ≈ 612pt, A5 ≈ 420pt, B5 ≈ 499pt.
  const pageWidthPt = ({ A4: 595, Letter: 612, A5: 420, B5: 499 } as const)[size];
  const contentPt = pageWidthPt - 2 * marginPt;
  return Math.max(100, Math.round((contentPt * 96) / 72));
}

// -- Image resolution ---------------------------------------------------

interface ResolvedImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number; // natural pixel width
  readonly height: number; // natural pixel height
  readonly type: 'png' | 'jpg' | 'gif' | 'bmp';
}

/**
 * First sweep: find every `<img>` src in the tree, decode/fetch each
 * once, and return a `Map<src, ResolvedImage | null>` so the walker
 * can stay synchronous. `null` means "we tried but can't embed" — the
 * walker renders a placeholder.
 */
async function resolveAllImages(
  root: HastRoot,
  resolve: DocxExportOptions['resolveAsset'],
): Promise<Map<string, ResolvedImage | null>> {
  const srcs = new Set<string>();
  visit(root, 'element', (node: Element) => {
    if (node.tagName !== 'img') return;
    const src = typeof node.properties?.src === 'string' ? node.properties.src : '';
    if (src) srcs.add(src);
  });

  const entries = await Promise.all(
    [...srcs].map(async (src): Promise<[string, ResolvedImage | null]> => {
      try {
        const asset = src.startsWith('data:')
          ? decodeDataUrl(src)
          : resolve
            ? await resolve(src)
            : null;
        if (!asset) return [src, null];
        const img = probeImage(asset.bytes, asset.mime, asset.width, asset.height);
        return [src, img];
      } catch {
        // Swallow: a broken image should never break the whole export.
        return [src, null];
      }
    }),
  );
  return new Map(entries);
}

/**
 * Default ceiling on simultaneous `resolveMermaid` calls. Picked
 * empirically: the typical resolver (mmdr subprocess) is CPU-bound
 * and 4 concurrent renders saturate a small server's cores without
 * starving anything else. Override via `DocxExportOptions.mermaidConcurrency`.
 */
const DEFAULT_MERMAID_CONCURRENCY = 4;

/**
 * Read the mermaid-block index off a HAST `<div class="mermaid">`.
 * Returns -1 when no usable index is present.
 *
 * Two property-key spellings are accepted because the two upstream
 * plugins write hast differently:
 *   - `remarkMermaid` (markdown) emits raw HTML `<div data-mermaid-index="N">`
 *     which `rehypeRaw` parses; HTML attributes get normalised to
 *     camelCase property keys, so we see `dataMermaidIndex`.
 *   - `rehypeAsciidocMermaid` builds hast Elements directly with the
 *     hyphenated key (`'data-mermaid-index'`) and never round-trips
 *     through HTML, so the camelCase normaliser never fires.
 *
 * Both string and number values are tolerated; the asciidoc plugin
 * stringifies, but a future plugin might pass a bare number.
 */
function readMermaidIndex(node: Element): number {
  const props = node.properties ?? {};
  const raw =
    (props as Record<string, unknown>)['dataMermaidIndex'] ??
    (props as Record<string, unknown>)['data-mermaid-index'];
  let idx: number;
  if (typeof raw === 'number') {
    idx = raw;
  } else if (typeof raw === 'string') {
    // Strict integer match. `parseInt` would silently accept '1.5'
    // (→ 1) or '0abc' (→ 0) and mis-key the resolved-images map —
    // the upstream plugins always stringify a known integer, so any
    // string that doesn't pass this check is a malformed input we
    // shouldn't try to coerce.
    if (!/^\d+$/.test(raw)) return -1;
    idx = Number(raw);
  } else {
    return -1;
  }
  return Number.isInteger(idx) && idx >= 0 ? idx : -1;
}

/**
 * Walk the HAST for mermaid blocks (`<div class="mermaid"
 * data-mermaid-index="N">…source…</div>` from `remarkMermaid` or
 * `rehypeAsciidocMermaid`), resolve each through the caller's
 * `resolveMermaid` callback with bounded parallelism, and return a
 * Map keyed by the numeric index.
 *
 * Why index-keyed and not source-text-keyed: a document can legitimately
 * contain two identical diagrams (copy-paste) and we want each to render
 * independently — keying by source would dedupe them. The index is what
 * the upstream plugins emit as `data-mermaid-index`, and is unique
 * per block by construction.
 *
 * Why bounded: the typical server-side resolver spawns an `mmdr`
 * subprocess per call. An unbounded `Promise.all` over a 20-diagram
 * doc would fork 20 simultaneous renderer processes and starve the
 * host. The pool size is configurable via `mermaidConcurrency` so
 * cheap resolvers (in-memory cache) can opt back into wider parallelism.
 *
 * No callback → empty map; the walker reads that as "no resolved
 * mermaid available" and falls back to the existing labeled-code-block
 * stopgap. Same swallow-on-error policy as `resolveAllImages`: a single
 * broken diagram never breaks the whole export.
 */
async function resolveAllMermaid(
  root: HastRoot,
  resolve: DocxExportOptions['resolveMermaid'],
  concurrencyOption?: number,
): Promise<Map<number, ResolvedImage | null>> {
  if (!resolve) return new Map();
  interface Block {
    index: number;
    source: string;
  }
  const blocks: Block[] = [];
  visit(root, 'element', (node: Element) => {
    if (node.tagName !== 'div') return;
    const cls = node.properties?.className;
    if (!Array.isArray(cls) || !(cls as unknown[]).includes('mermaid')) return;
    const idx = readMermaidIndex(node);
    if (idx < 0) return;
    blocks.push({ index: idx, source: hastTextContent(node) });
  });
  const limit = Math.max(
    1,
    typeof concurrencyOption === 'number' && Number.isFinite(concurrencyOption)
      ? Math.floor(concurrencyOption)
      : DEFAULT_MERMAID_CONCURRENCY,
  );
  const entries = await mapWithConcurrency(
    blocks,
    limit,
    async ({ index, source }): Promise<[number, ResolvedImage | null]> => {
      try {
        const asset = await resolve(source, index);
        if (!asset) return [index, null];
        const img = probeImage(asset.bytes, asset.mime, asset.width, asset.height);
        return [index, img];
      } catch {
        // Swallow: a broken diagram should fall back to the
        // code-block stopgap, not blow up the whole export.
        return [index, null];
      }
    },
  );
  return new Map(entries);
}

/**
 * Tiny worker-pool helper: map `items` through `fn` with at most
 * `limit` calls in flight at once. Output order matches input order.
 *
 * Implemented as N "worker" coroutines that pull the next index off
 * a shared cursor — simpler than a queue + drain, and correct for
 * our use (no per-item priority, no early termination).
 */
async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const out = new Array<U>(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function decodeDataUrl(url: string): ResolvedAsset | null {
  // data:[<mime>][;base64],<data>
  const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const isBase64 = m[2] === ';base64';
  const payload = m[3] ?? '';
  try {
    // `Buffer.from(…, 'base64')` is available in Node, Bun, and is
    // an alias of `Uint8Array` under the hood — no allocation copy
    // vs the `atob` + `Uint8Array.from(s, charCodeAt)` pattern,
    // which also has the downside that `atob` is a Web API not
    // guaranteed on every Node version.
    const bytes: Uint8Array = isBase64
      ? Buffer.from(payload, 'base64')
      : new TextEncoder().encode(decodeURIComponent(payload));
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Probe an asset for the dimensions docx should display it at.
 *
 * If the caller passed `displayWidth` / `displayHeight` explicitly
 * (set on `ResolvedAsset` — used by the chromium mermaid resolver
 * to ship a high-resolution PNG without enlarging the diagram on
 * the page), those win. Otherwise we read the raw pixel size from
 * the bytes — correct for 1× sources like user uploads or the mmdr
 * raster output where actual pixels equal natural CSS pixels.
 */
function probeImage(
  bytes: Uint8Array,
  mime: string,
  displayWidth?: number,
  displayHeight?: number,
): ResolvedImage | null {
  const type = mimeToDocxType(mime);
  if (!type) return null; // SVG and others unsupported for now (see M4b).
  try {
    const info = imageSize(bytes);
    if (!info.width || !info.height) return null;
    const width =
      displayWidth && displayWidth > 0 ? Math.round(displayWidth) : info.width;
    const height =
      displayHeight && displayHeight > 0 ? Math.round(displayHeight) : info.height;
    return { bytes, mime, width, height, type };
  } catch {
    return null;
  }
}

function mimeToDocxType(mime: string): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  const m = mime.toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/bmp' || m === 'image/x-ms-bmp') return 'bmp';
  return null;
}

// -- Footnote extraction ------------------------------------------------

/**
 * GFM-style footnotes ship as a `<section data-footnotes>` at the end
 * of the document. We lift them out so they render as real Word
 * footnotes instead of an inline bibliography. Returns:
 *
 * - `ids`: slug → numeric DOCX footnote id (1-based, assigned in
 *   document order).
 * - `content`: the shape Document's constructor expects —
 *   `{ [id]: { children: Paragraph[] } }`.
 *
 * Mutates `root` by removing the footnotes section, which keeps the
 * body walker from emitting the content twice.
 */
function extractFootnotes(
  root: HastRoot,
  ctx: BuildCtx,
): {
  ids: Map<string, number>;
  content: Record<string, { children: Paragraph[] }>;
} {
  const ids = new Map<string, number>();
  const content: Record<string, { children: Paragraph[] }> = {};

  // Find every `<section class="footnotes">` (also marked with
  // `data-footnotes`), regardless of whether it sits at the root or
  // inside an `<html>/<body>` wrapper introduced by some input paths
  // (e.g. the AsciiDoc re-parse path). `visit` recurses through the
  // tree and records the parent array + index so we can splice the
  // section out after processing.
  interface FootnoteSectionHit {
    section: Element;
    parent: Parent;
    index: number;
  }
  const hits: FootnoteSectionHit[] = [];
  visit(root, 'element', (node: Element, index, parent) => {
    if (node.tagName !== 'section') return;
    const cls = node.properties?.className;
    const isFootnotes =
      (Array.isArray(cls) && (cls as unknown[]).includes('footnotes')) ||
      node.properties?.['dataFootnotes'] !== undefined;
    if (!isFootnotes || !parent || index === undefined) return;
    hits.push({ section: node, parent: parent as Parent, index });
  });

  // Walk each hit in the order we found them so footnote ids are
  // numbered in document order.
  for (const { section } of hits) {
    const ol = findChild(section, 'ol');
    if (!ol) continue;
    let nextId = ids.size + 1;
    for (const li of ol.children) {
      if (!isElement(li) || li.tagName !== 'li') continue;
      const rawId = typeof li.properties?.id === 'string' ? li.properties.id : '';
      // GFM prefixes the id with `user-content-fn-`; strip it so the
      // inline ref lookup (which strips the same prefix from the
      // `<a href>`) matches.
      const slug = stripFootnotePrefix(rawId);
      if (!slug) continue;
      const id = nextId++;
      ids.set(slug, id);
    }
  }

  // Second pass: build the Paragraph content, now that every slug
  // has an id. The ctx passed to `buildFootnoteParagraphs` must
  // carry the populated `ids` map — otherwise a footnote body that
  // references *another* footnote would find an empty lookup table
  // and fall back to rendering the reference as plain text.
  const ctxWithIds: BuildCtx = { ...ctx, footnoteIds: ids };
  for (const { section } of hits) {
    const ol = findChild(section, 'ol');
    if (!ol) continue;
    for (const li of ol.children) {
      if (!isElement(li) || li.tagName !== 'li') continue;
      const rawId = typeof li.properties?.id === 'string' ? li.properties.id : '';
      const slug = stripFootnotePrefix(rawId);
      if (!slug) continue;
      const id = ids.get(slug);
      if (id === undefined) continue;
      content[String(id)] = { children: buildFootnoteParagraphs(li, ctxWithIds) };
    }
  }

  // Splice every hit out of its parent. Re-resolve the current index
  // via `indexOf` at splice time so earlier splices (in the same
  // parent, or in an ancestor chain) don't invalidate the stored
  // index captured during visit.
  for (const { section, parent } of hits) {
    const children = parent.children as HastNode[];
    const idx = children.indexOf(section);
    if (idx !== -1) children.splice(idx, 1);
  }

  return { ids, content };
}

/** Strip GFM's `user-content-fn-` prefix; return null if unrecognized. */
function stripFootnotePrefix(id: string): string | null {
  const m = id.match(/^(?:user-content-)?fn-(.+)$/);
  return m ? (m[1] ?? null) : null;
}

function findChild(parent: Element, tagName: string): Element | null {
  for (const c of parent.children) {
    if (isElement(c) && c.tagName === tagName) return c;
  }
  return null;
}

/**
 * Turn the content inside a `<li>` footnote definition into DOCX
 * Paragraphs, skipping the trailing backref link (the `↩` arrow that
 * GFM adds to jump back to the reference — Word generates its own
 * visual for this automatically).
 *
 * Footnote bodies can be multi-block: paragraphs, lists, code, quotes.
 * We lean on the shared block walker for anything that converts to
 * paragraphs natively, and fall back to a flattened plain-text
 * paragraph for structures DOCX footnotes can't host (tables).
 * Silently dropping user content is worse than a simplified rendering.
 */
function buildFootnoteParagraphs(li: Element, ctx: BuildCtx): Paragraph[] {
  const out: Paragraph[] = [];
  for (const child of li.children as HastNode[]) {
    if (isElement(child)) {
      appendFootnoteBlock(child, ctx, out, 0);
      continue;
    }
    // Inline text directly inside the <li> (rare — usually GFM wraps
    // footnote bodies in a <p>, but loose text can show up if the
    // content survives sanitize without a paragraph wrapper) becomes
    // its own paragraph so it's not silently dropped.
    if (isText(child)) {
      const text = child.value.trim();
      if (text) out.push(new Paragraph({ children: [new TextRun({ text })] }));
    }
  }
  if (out.length === 0) {
    // Always emit at least one paragraph so the footnote renders —
    // blank footnotes would confuse readers more than an empty line.
    out.push(new Paragraph({ children: [] }));
  }
  return out;
}

function appendFootnoteBlock(
  node: Element,
  ctx: BuildCtx,
  out: Paragraph[],
  blockquoteDepth: number,
): void {
  const quoteIndent = blockquoteDepth > 0 ? pt2twip(BLOCKQUOTE_INDENT_PT * blockquoteDepth) : 0;
  const quoted = (options: ParagraphOptions): ParagraphOptions =>
    blockquoteDepth > 0
      ? {
          ...options,
          style: options.style ?? 'Blockquote',
          indent: {
            ...(options.indent ?? {}),
            left: (typeof options.indent?.left === 'number' ? options.indent.left : 0) + quoteIndent,
          },
        }
      : options;

  switch (node.tagName) {
    case 'p': {
      const inline = collectInline(node, ctx, {});
      if (inline.length > 0) out.push(new Paragraph(quoted({ children: inline })));
      return;
    }
    case 'pre':
      // Reuses the CodeBlock style built for the body; still valid
      // inside footnote paragraphs.
      out.push(...buildCodeBlock(node, ctx.tokens));
      return;
    case 'blockquote':
      // Same nested-content concern as the main walker's
      // blockquote handler: a quote inside a footnote can contain
      // lists, code blocks, multiple paragraphs. `<p>` → Blockquote
      // paragraph; everything else recurses so its own structure
      // (list prefix, code block, etc.) survives.
      for (const c of node.children as HastNode[]) {
        if (!isElement(c)) {
          if (isText(c) && c.value.trim()) {
            out.push(
              new Paragraph(
                quoted({
                  style: 'Blockquote',
                  children: [new TextRun({ text: c.value })],
                }),
              ),
            );
          }
          continue;
        }
        appendFootnoteBlock(c, ctx, out, blockquoteDepth + 1);
      }
      return;
    case 'ul':
    case 'ol': {
      // DOCX numbering refs are document-scoped, so we can't share
      // `marginalia-bullet` / `marginalia-ordered` cleanly here —
      // Word would restart the main list's numbering every time a
      // footnote contained a list. Prefix each item manually: this
      // keeps content intact and readable without polluting the
      // numbering registry.
      const ordered = node.tagName === 'ol';
      let index = 1;
      for (const item of node.children as HastNode[]) {
        if (!isElement(item) || item.tagName !== 'li') continue;
        const prefix = ordered ? `${index++}. ` : '• ';
        const children = collectInline(item, ctx, {});
        out.push(
          new Paragraph(
            quoted({
              children: [new TextRun({ text: prefix }), ...children],
            }),
          ),
        );
      }
      return;
    }
    case 'section':
    case 'div':
    case 'figure':
    case 'article':
      for (const c of node.children as HastNode[]) {
        if (isElement(c)) appendFootnoteBlock(c, ctx, out, blockquoteDepth);
      }
      return;
    default: {
      // Last-resort: flatten to plain text so nothing the user wrote
      // disappears silently. `hastTextContent` strips tags; the
      // trailing backref `↩` is still inside the tree here but
      // walkInline-free paths need their own filter. We keep it: the
      // arrow is a literal Unicode char, harmless if it slips through.
      const text = hastTextContent(node).trim();
      if (text) out.push(new Paragraph(quoted({ children: [new TextRun({ text })] })));
      return;
    }
  }
}

// -- Document assembly --------------------------------------------------

interface DocumentLang {
  readonly language: string | null;
  readonly rtl: boolean;
}

function buildDocument(
  body: readonly FileChild[],
  tokens: ThemeTokens,
  options: DocxExportOptions,
  footnotes: Readonly<Record<string, { readonly children: readonly Paragraph[] }>>,
  lang: DocumentLang,
): Document {
  // `options.pageSize` overrides the theme default when the caller
  // needs a specific sheet size regardless of theme. Margins still
  // come from the theme — nobody wants Letter with A4-height margins.
  const effectivePageSize = options.pageSize ?? tokens.page.size;
  const section: ISectionOptions = {
    properties: {
      page: {
        size: pageSizeOf(effectivePageSize),
        margin: {
          top: pt2twip(tokens.page.marginPt),
          bottom: pt2twip(tokens.page.marginPt),
          left: pt2twip(tokens.page.marginPt),
          right: pt2twip(tokens.page.marginPt),
        },
      },
    },
    children: [...body],
  };

  const hasFootnotes = Object.keys(footnotes).length > 0;
  return new Document({
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.author !== undefined
      ? { creator: options.author, lastModifiedBy: options.author }
      : {}),
    styles: buildStyles(tokens, lang),
    numbering: buildNumbering(),
    ...(hasFootnotes ? { footnotes } : {}),
    sections: [section],
  });
}

function pageSizeOf(
  size: ThemeTokens['page']['size'],
): { width: number; height: number } {
  // DOCX uses twips; sizes below cover the theme token enum values.
  // 1 mm = ~56.69 twips; use convertMillimetersToTwip for accuracy.
  const mm = (w: number, h: number) => ({
    width: convertMillimetersToTwip(w),
    height: convertMillimetersToTwip(h),
  });
  switch (size) {
    case 'Letter':
      return { width: 12240, height: 15840 }; // 8.5" x 11" in twips
    case 'A5':
      return mm(148, 210);
    case 'B5':
      return mm(176, 250);
    default:
      return mm(210, 297); // A4
  }
}

function buildStyles(
  tokens: ThemeTokens,
  lang: DocumentLang,
): NonNullable<ConstructorParameters<typeof Document>[0]['styles']> {
  const bodyFont = tokens.fonts.body.families[0] ?? 'serif';
  const headingFont = tokens.fonts.heading.families[0] ?? bodyFont;
  const monoFont = tokens.fonts.mono.families[0] ?? 'monospace';
  const base = tokens.fontSize.basePt;
  // BCP-47 `lang` tag used for complex-script / bidirectional runs so
  // Word's spell-checker and font substitution pick up the right
  // language. Null → let Word use the user's default.
  const languageRun = lang.language
    ? { language: { value: lang.language, bidirectional: lang.language } }
    : {};

  const heading = (
    id: string,
    level: keyof typeof HeadingLevel,
    multiplier: number,
    uppercase: boolean,
  ) => ({
    id,
    name: id,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: {
      font: headingFont,
      color: hex(tokens.colors.fg),
      size: pt2hp(base * multiplier),
      bold: tokens.headingWeight >= 600,
      allCaps: uppercase,
      characterSpacing: Math.round(tokens.headingLetterSpacingEm * 20 * base),
    },
    paragraph: {
      spacing: {
        before: pt2twip(tokens.spacing.headingTopEm * base),
        after: pt2twip(tokens.spacing.blockEm * base * 0.5),
        line: Math.round(tokens.lineHeight.heading * 240),
      },
      keepNext: true,
      keepLines: true,
      outlineLevel: HeadingLevel[level] === HeadingLevel.TITLE ? 0 : parseInt(id.slice(-1), 10) - 1,
    },
  });

  return {
    default: {
      document: {
        run: {
          font: bodyFont,
          size: pt2hp(base),
          color: hex(tokens.colors.fg),
          ...languageRun,
        },
        paragraph: {
          spacing: {
            after: pt2twip(tokens.spacing.blockEm * base * 0.5),
            line: DOCX_BODY_LINE_SPACING,
          },
          // `bidirectional: true` flips the paragraph direction to
          // right-to-left; combined with the `lang` hint above, Word
          // handles mixed-direction text correctly.
          ...(lang.rtl ? { bidirectional: true } : {}),
        },
      },
    },
    paragraphStyles: [
      heading('Heading1', 'HEADING_1', tokens.fontSize.h1Em, tokens.headingUppercase.h1),
      heading('Heading2', 'HEADING_2', tokens.fontSize.h2Em, tokens.headingUppercase.h2),
      heading('Heading3', 'HEADING_3', tokens.fontSize.h3Em, tokens.headingUppercase.h3),
      heading('Heading4', 'HEADING_4', tokens.fontSize.h4Em, tokens.headingUppercase.h4),
      heading('Heading5', 'HEADING_5', tokens.fontSize.h5Em, tokens.headingUppercase.h5),
      heading('Heading6', 'HEADING_6', tokens.fontSize.h6Em, tokens.headingUppercase.h6),
      {
        id: 'Blockquote',
        name: 'Blockquote',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          italics: tokens.blockquote.italic,
          color: hex(tokens.colors.fgMuted),
        },
        paragraph: {
          indent: { left: pt2twip(BLOCKQUOTE_INDENT_PT) },
          border: tokens.blockquote.hasBar
            ? {
                left: {
                  style: BorderStyle.SINGLE,
                  size: 24, // eighths of a point = 3pt bar
                  color: hex(tokens.colors.quoteBar),
                  space: 8,
                },
              }
            : {},
          spacing: {
            before: pt2twip(tokens.spacing.blockEm * base * 0.3),
            after: pt2twip(tokens.spacing.blockEm * base * 0.3),
            line: DOCX_BODY_LINE_SPACING,
          },
        },
      },
      {
        id: 'CodeBlock',
        name: 'Code Block',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          font: monoFont,
          size: pt2hp(base * 0.9),
          color: hex(tokens.colors.codeFg),
        },
        paragraph: {
          shading: {
            type: ShadingType.CLEAR,
            fill: hex(tokens.colors.codeBg),
            color: 'auto',
          },
          indent: { left: pt2twip(12), right: pt2twip(12) },
          spacing: {
            before: pt2twip(tokens.spacing.blockEm * base * 0.3),
            after: pt2twip(tokens.spacing.blockEm * base * 0.3),
            line: Math.round(1.4 * 240),
          },
          contextualSpacing: true,
        },
      },
      {
        id: 'TableHeader',
        name: 'Table Header',
        basedOn: 'Normal',
        next: 'Normal',
        run: { bold: true, color: hex(tokens.colors.fg) },
      },
      {
        // "Contents" label above the TOC. Deliberately NOT a
        // `Heading1`-`Heading6` so the TOC field (which pulls
        // `headingStyleRange: '1-6'`) doesn't list "Contents" as its
        // own entry. Matches Word's built-in "TOC Heading" role.
        id: 'TocHeading',
        name: 'TOC Heading',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: headingFont,
          size: pt2hp(base * 1.55),
          bold: true,
          color: hex(tokens.colors.fg),
        },
        paragraph: {
          spacing: {
            before: pt2twip(tokens.spacing.blockEm * base * 0.5),
            after: pt2twip(tokens.spacing.blockEm * base * 0.5),
            line: Math.round(tokens.lineHeight.heading * 240),
          },
          keepNext: true,
          keepLines: true,
        },
      },
    ],
  };
}

function buildNumbering(): NonNullable<
  ConstructorParameters<typeof Document>[0]['numbering']
> {
  return {
    config: [
      {
        reference: 'marginalia-bullet',
        levels: Array.from({ length: 6 }, (_, lvl) => ({
          level: lvl,
          format: LevelFormat.BULLET,
          text: ['•', '◦', '▪', '•', '◦', '▪'][lvl] ?? '•',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: pt2twip(18 * (lvl + 1)), hanging: pt2twip(18) },
            },
          },
        })),
      },
      {
        reference: 'marginalia-ordered',
        levels: Array.from({ length: 6 }, (_, lvl) => ({
          level: lvl,
          format: LevelFormat.DECIMAL,
          text: `%${lvl + 1}.`,
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: pt2twip(18 * (lvl + 1)), hanging: pt2twip(18) },
            },
          },
        })),
      },
    ],
  };
}

// -- HAST walker --------------------------------------------------------

/**
 * Walker-wide context. Pre-resolved images and theme tokens are stable
 * for the whole document — passing them through every call by closure
 * would be noisier than a single ctx object.
 */
interface BuildCtx {
  readonly tokens: ThemeTokens;
  readonly images: Map<string, ResolvedImage | null>;
  /**
   * Pre-resolved mermaid renders, keyed by the numeric index that
   * `remarkMermaid` writes onto each `<div class="mermaid"
   * data-mermaid-index="N">`. `null` means we tried but the renderer
   * couldn't produce usable bytes — the walker falls back to the
   * labeled-code-block stopgap. An empty map can mean the caller
   * didn't supply `resolveMermaid`, or simply that the document had
   * no mermaid blocks to resolve; the walker falls back whenever no
   * usable rendered image is available for a mermaid block.
   */
  readonly mermaidImages: Map<number, ResolvedImage | null>;
  readonly pageWidthPx: number;
  /**
   * GFM footnote slug → numeric DOCX footnote id (1-based). Populated
   * by `extractFootnotes` before walking; read when the inline walker
   * hits a `<sup><a data-footnote-ref>` reference.
   */
  readonly footnoteIds: Map<string, number>;
  /**
   * TOC blocks waiting to be emitted at the first `[TOC]` / `[[_TOC_]]`
   * marker. The walker consumes this when it encounters the marker
   * element; later markers find `consumed: true` and skip silently.
   *
   * Null when:
   *  - the document contains no markers (the caller's heuristic
   *    injection point is used instead);
   *  - `includeToc: false` (markers should be ignored).
   */
  readonly pendingToc?: { blocks: FileChild[]; consumed: boolean } | null;
}

type InlineStyle = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  bg?: string;
  font?: string;
  size?: number; // half-points
  /** Underline, for hyperlinks. Omit for plain text. */
  underline?: { color?: string };
};

function isElement(n: HastNode | undefined): n is Element {
  return !!n && n.type === 'element';
}

function isText(n: HastNode | undefined): n is Text {
  return !!n && n.type === 'text';
}

/** Concatenate the plain-text content of a hast subtree (no formatting). */
function hastTextContent(node: HastNode): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return '';
  let out = '';
  for (const c of node.children as HastNode[]) out += hastTextContent(c);
  return out;
}

interface WalkOptions {
  /**
   * Index (into the flattened top-level hast children) AFTER which the
   * caller wants additional blocks inserted. `-1` or undefined means
   * no injection. Used to place a TOC block immediately after the
   * document's first heading without having to post-process the
   * output paragraphs (which would need heading-style detection).
   */
  injectAfterTopLevelIndex?: number;
  /** Blocks to splice in after the injection index has been processed. */
  injectedBlocks?: readonly FileChild[];
}

function hastToDocxChildren(
  root: HastRoot,
  ctx: BuildCtx,
  options: WalkOptions = {},
): FileChild[] {
  const out: FileChild[] = [];
  const topLevel = flattenRoot(root);
  const injectAt = options.injectAfterTopLevelIndex ?? -1;
  let afterTable = false;
  for (let i = 0; i < topLevel.length; i++) {
    const node = topLevel[i] as HastNode;
    convertBlock(node, ctx, out, { listDepth: 0, blockquoteDepth: 0, afterTable });
    if (!isIgnorableBlockWhitespace(node)) {
      afterTable = blockEndsWithTable(node);
    }
    if (i === injectAt && options.injectedBlocks) {
      out.push(...options.injectedBlocks);
    }
  }
  return out;
}

/**
 * Index of the document's "opening heading", or -1 if there isn't one.
 *
 * A heading counts as the opener only if it's the first
 * non-whitespace top-level element in the body. That matches the
 * user's mental model ("the document title"): if the doc starts with
 * an intro paragraph before any heading, the TOC goes at the top, not
 * after some arbitrary downstream heading.
 */
function indexOfLeadingHeading(root: HastRoot): number {
  const children = flattenRoot(root);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    // Whitespace-only text at the top is noise — skip it.
    if (isText(node) && node.value.trim() === '') continue;
    if (isElement(node) && /^h[1-6]$/.test(node.tagName)) return i;
    return -1; // first real block is NOT a heading → TOC goes at the top.
  }
  return -1;
}

/**
 * Detect whether the document contains at least one `[TOC]` /
 * `[[_TOC_]]` marker at the top level. Used by the caller to pick
 * between marker-driven placement and the leading-heading heuristic.
 * A marker inside a nested block (blockquote, list item, etc.) is
 * deliberately ignored — it would be ambiguous content anyway.
 */
function hasTocMarker(root: HastRoot): boolean {
  for (const node of flattenRoot(root)) {
    if (isTocMarkerElement(node)) return true;
  }
  return false;
}

function isTocMarkerElement(node: HastNode): boolean {
  if (!isElement(node) || node.tagName !== 'div') return false;
  const cls = node.properties?.className;
  return Array.isArray(cls) && (cls as unknown[]).includes(TOC_MARKER_CLASSNAME);
}

/** Peel <html>/<body> wrappers if present so we iterate real blocks. */
function flattenRoot(root: HastRoot): readonly HastNode[] {
  let children = root.children as HastNode[];
  // rehype-parse with fragment:true gives us a flat root, but rehype-raw
  // can introduce <html><body> wrappers depending on input. Peel them.
  while (children.length === 1 && isElement(children[0])) {
    const only = children[0];
    if (only.tagName === 'html' || only.tagName === 'body') {
      children = only.children as HastNode[];
      continue;
    }
    break;
  }
  return children;
}

interface WalkCtx {
  readonly listDepth: number;
  readonly inOrderedList?: boolean;
  readonly blockquoteDepth: number;
  readonly afterTable?: boolean;
}

type ParagraphOptions = Exclude<ConstructorParameters<typeof Paragraph>[0], string>;

function tableLeadSpacingTwip(tokens: ThemeTokens): number {
  return pt2twip(tokens.spacing.blockEm * tokens.fontSize.basePt * 0.5);
}

function blockquoteSpacingTwip(tokens: ThemeTokens): { before: number; after: number } {
  const spacing = pt2twip(tokens.spacing.blockEm * tokens.fontSize.basePt * 0.3);
  return { before: spacing, after: spacing };
}

function blockquoteBorder(tokens: ThemeTokens): ParagraphOptions['border'] {
  return tokens.blockquote.hasBar
    ? {
        left: {
          style: BorderStyle.SINGLE,
          size: 24,
          color: hex(tokens.colors.quoteBar),
          space: 8,
        },
      }
    : undefined;
}

function withParagraphContext(
  options: ParagraphOptions,
  ctx: BuildCtx,
  walk: WalkCtx,
): ParagraphOptions {
  let next = { ...options };

  next = {
    ...next,
    spacing: {
      ...(next.spacing ?? {}),
      line: next.spacing?.line ?? DOCX_BODY_LINE_SPACING,
    },
  };

  if (walk.afterTable) {
    next = {
      ...next,
      spacing: {
        ...(next.spacing ?? {}),
        before: tableLeadSpacingTwip(ctx.tokens),
      },
    };
  }

  if (walk.blockquoteDepth > 0) {
    const quoteIndent = pt2twip(BLOCKQUOTE_INDENT_PT * walk.blockquoteDepth);
    const quoteSpacing = blockquoteSpacingTwip(ctx.tokens);
    const border = blockquoteBorder(ctx.tokens);
    next = {
      ...next,
      style: next.style ?? 'Blockquote',
      ...(border ? { border: { ...(next.border ?? {}), ...border } } : {}),
      indent: {
        ...(next.indent ?? {}),
        left: (typeof next.indent?.left === 'number' ? next.indent.left : 0) + quoteIndent,
      },
      spacing: {
        ...(next.spacing ?? {}),
        before: next.spacing?.before ?? quoteSpacing.before,
        after: next.spacing?.after ?? quoteSpacing.after,
        line: next.spacing?.line ?? DOCX_BODY_LINE_SPACING,
      },
    };
  }

  return next;
}

function isIgnorableBlockWhitespace(node: HastNode): boolean {
  return isText(node) && node.value.trim() === '';
}

function blockEndsWithTable(node: HastNode): boolean {
  if (isIgnorableBlockWhitespace(node)) return false;
  if (!isElement(node)) return false;
  if (node.tagName === 'table') return true;
  if (
    node.tagName === 'blockquote' ||
    node.tagName === 'figure' ||
    node.tagName === 'section' ||
    node.tagName === 'article' ||
    node.tagName === 'div'
  ) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i] as HastNode;
      if (isIgnorableBlockWhitespace(child)) continue;
      return blockEndsWithTable(child);
    }
  }
  return false;
}

function convertBlock(
  node: HastNode,
  ctx: BuildCtx,
  out: FileChild[],
  walk: WalkCtx,
): void {
  const tokens = ctx.tokens;
  if (!isElement(node)) {
    // Bare text at block level → wrap in a paragraph.
    if (isText(node) && node.value.trim()) {
      out.push(
        new Paragraph(
          withParagraphContext({ children: [new TextRun({ text: node.value })] }, ctx, walk),
        ),
      );
    }
    return;
  }

  switch (node.tagName) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      out.push(buildHeading(node, ctx));
      return;

    case 'p':
      out.push(
        new Paragraph(withParagraphContext({ children: collectInline(node, ctx, {}) }, ctx, walk)),
      );
      return;

    case 'blockquote':
      // A blockquote is a context: nested paragraphs and list items
      // should still carry the quote's left bar/indent instead of
      // only direct `<p>` children doing so.
      {
        let afterTable = walk.afterTable ?? false;
        for (const child of node.children as HastNode[]) {
          convertBlock(child, ctx, out, {
            ...walk,
            blockquoteDepth: walk.blockquoteDepth + 1,
            afterTable,
          });
          if (!isIgnorableBlockWhitespace(child)) {
            afterTable = blockEndsWithTable(child);
          }
        }
      }
      return;

    case 'ul':
    case 'ol':
      convertList(node, ctx, out, walk);
      return;

    case 'pre':
      out.push(...buildCodeBlock(node, tokens));
      return;

    case 'table':
      out.push(buildTable(node, ctx));
      return;

    case 'hr':
      out.push(
        new Paragraph({
          border: {
            top: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: hex(tokens.colors.border),
              space: 1,
            },
          },
          spacing: {
            before: pt2twip(tokens.spacing.blockEm * tokens.fontSize.basePt * 0.5),
            after: pt2twip(tokens.spacing.blockEm * tokens.fontSize.basePt * 0.5),
          },
        }),
      );
      return;

    case 'figure':
    case 'section':
    case 'article':
      // Transparent containers: walk children.
      {
        let afterTable = walk.afterTable ?? false;
        for (const child of node.children as HastNode[]) {
          convertBlock(child, ctx, out, { ...walk, afterTable });
          if (!isIgnorableBlockWhitespace(child)) {
            afterTable = blockEndsWithTable(child);
          }
        }
      }
      return;

    case 'div': {
      const cls = node.properties?.className;
      // `[TOC]` / `[[_TOC_]]` marker: the remark plugin replaced the
      // paragraph with `<div class="marginalia-toc-marker">`. If the
      // caller queued TOC blocks, emit them here (first marker wins).
      // Silently drop later markers and any marker when TOC is
      // suppressed via `includeToc: false`.
      const isMarker =
        Array.isArray(cls) && (cls as unknown[]).includes(TOC_MARKER_CLASSNAME);
      if (isMarker) {
        const pending = ctx.pendingToc;
        if (pending && !pending.consumed) {
          out.push(...pending.blocks);
          pending.consumed = true;
        }
        return;
      }
      // `<div class="mermaid">` carries the diagram source. If the
      // caller wired up `resolveMermaid` and the renderer produced
      // bytes, embed it as a real image. Otherwise fall back to a
      // labeled code block so the diagram source is still readable
      // in the doc.
      const isMermaid =
        Array.isArray(cls) && (cls as unknown[]).includes('mermaid');
      if (isMermaid) {
        // Use the same index reader as `resolveAllMermaid` so the
        // walker and resolver agree on which key spelling carries the
        // index (markdown → camelCase, asciidoc → hyphenated).
        const idx = readMermaidIndex(node);
        const resolved = idx >= 0 ? ctx.mermaidImages.get(idx) : null;
        if (resolved) {
          const run = buildMermaidImageRun(resolved, ctx);
          out.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [run],
            }),
          );
          return;
        }
        const source = hastTextContent(node);
        out.push(
          new Paragraph({
            children: [
              new TextRun({
                text: '◇ mermaid diagram',
                italics: true,
                color: hex(tokens.colors.fgMuted),
              }),
            ],
          }),
        );
        for (const line of source.split('\n')) {
          out.push(
            new Paragraph({
              style: 'CodeBlock',
              children: [new TextRun({ text: line })],
            }),
          );
        }
        return;
      }
      // Generic `<div>`: walk children like other transparent wrappers.
      {
        let afterTable = walk.afterTable ?? false;
        for (const child of node.children as HastNode[]) {
          convertBlock(child, ctx, out, { ...walk, afterTable });
          if (!isIgnorableBlockWhitespace(child)) {
            afterTable = blockEndsWithTable(child);
          }
        }
      }
      return;
    }

    case 'img':
      out.push(buildImageParagraph(node, ctx));
      return;

    default:
      // Unknown element — treat as paragraph of its inline content.
      // Skips script/style/etc. that sanitize already removes.
      if (node.children && node.children.length > 0) {
        const inline = collectInline(node, ctx, {});
        if (inline.length > 0) {
          out.push(new Paragraph(withParagraphContext({ children: inline }, ctx, walk)));
        }
      }
      return;
  }
}

function buildHeading(node: Element, ctx: BuildCtx): Paragraph {
  const level = Number(node.tagName[1]);
  const styleId = `Heading${level}`;
  // Skip the `<a class="heading-anchor">` sigil added by
  // `rehypeHeadingAnchors` — the id we need comes from the heading
  // element itself. That id is the Unicode-safe slug used throughout
  // the app for TOC links.
  const id = typeof node.properties?.id === 'string' ? node.properties.id : '';
  const inline = collectInline(node, ctx, {});
  // Wrap the heading's runs in a Bookmark so internal links
  // (`[Section](#section)`) can navigate to it inside Word. Without an
  // id we just emit the paragraph unwrapped — still valid.
  const children: ParagraphChild[] = id
    ? [new Bookmark({ id, children: inline })]
    : inline;
  return new Paragraph({
    style: styleId,
    heading: headingLevelOf(level),
    children,
  });
}

/**
 * Build a standalone image paragraph. Used when `<img>` appears at
 * block level (typical markdown `![alt](url)` on its own line). Images
 * are scaled to fit the content column width while preserving aspect
 * ratio — matches the CSS rule `.marginalia img { max-width: 100% }`.
 */
function buildImageParagraph(node: Element, ctx: BuildCtx): Paragraph {
  const run = maybeBuildImageRun(node, ctx);
  if (run) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [run],
    });
  }
  // Unresolvable → placeholder paragraph (same visual as a broken
  // inline image, but promoted to a full paragraph since that's the
  // context we're in).
  return new Paragraph({
    children: [
      new TextRun({
        text: `[image: ${imagePlaceholderLabel(node)}]`,
        italics: true,
        color: hex(ctx.tokens.colors.fgMuted),
      }),
    ],
  });
}

/**
 * Safe label for an unresolvable `<img>` placeholder. Prefers the
 * author's alt text, then a short identifier derived from the `src`
 * (filename-ish for URLs/paths; a fixed "embedded image" for data:
 * URLs), finally a generic "image".
 *
 * Kept deliberately short — a missing-alt image pointing at a 2 MB
 * base64 data: URL should NOT dump the whole URL into the DOCX as
 * visible text. That regression inflated files and made documents
 * unreadable.
 */
function imagePlaceholderLabel(node: Element): string {
  const altRaw = node.properties?.alt;
  if (typeof altRaw === 'string' && altRaw.trim()) return altRaw.trim().slice(0, 120);
  const srcRaw = node.properties?.src;
  if (typeof srcRaw !== 'string') return 'image';
  if (srcRaw.startsWith('data:')) return 'embedded image';
  // URL-or-path basename: strip query/fragment, take the last
  // non-empty segment. Works for `logo.png`, `https://cdn/pics/x.png`,
  // and `../dir/shot.jpg` alike. Cap length to stay readable.
  const basename = srcRaw.split(/[?#]/)[0]?.split('/').filter(Boolean).pop();
  if (basename && basename.length > 0) return basename.slice(0, 120);
  return 'image';
}

/**
 * Build an ImageRun from a pre-resolved image. Returns null if the
 * resolver couldn't find bytes, or the image type isn't supported
 * (e.g. SVG). The caller decides what to render instead.
 */
function maybeBuildImageRun(node: Element, ctx: BuildCtx): ImageRun | null {
  const src = typeof node.properties?.src === 'string' ? node.properties.src : '';
  if (!src) return null;
  const img = ctx.images.get(src);
  if (!img) return null;

  // Scale to fit content column. If the <img> carries explicit width
  // or height attributes, honor them (subject to the column ceiling)
  // so in-doc sizing hints survive the export.
  const explicitW =
    typeof node.properties?.width === 'number'
      ? node.properties.width
      : Number.parseInt(String(node.properties?.width ?? ''), 10) || null;
  const explicitH =
    typeof node.properties?.height === 'number'
      ? node.properties.height
      : Number.parseInt(String(node.properties?.height ?? ''), 10) || null;

  let width = explicitW ?? img.width;
  let height = explicitH ?? img.height;
  if (!explicitH && explicitW) height = Math.round((explicitW / img.width) * img.height);
  if (!explicitW && explicitH) width = Math.round((explicitH / img.height) * img.width);

  const maxW = ctx.pageWidthPx;
  if (width > maxW) {
    const scale = maxW / width;
    width = maxW;
    height = Math.round(height * scale);
  }

  const alt = typeof node.properties?.alt === 'string' ? node.properties.alt : '';
  const opts = {
    type: img.type,
    data: img.bytes,
    transformation: { width, height },
    ...(alt ? { altText: { title: alt, description: alt, name: alt } } : {}),
  };
  // Narrowed through the union; docx requires `as` here because
  // TypeScript can't infer the discriminated constructor overload.
  return new ImageRun(opts as ConstructorParameters<typeof ImageRun>[0]);
}

/**
 * Build an ImageRun for a pre-resolved mermaid render. Same scaling
 * rule as a normal block image (fit content column width, preserve
 * aspect ratio) — the diagram's natural dimensions came from probing
 * the rendered PNG, so the maths is identical to `maybeBuildImageRun`.
 *
 * Kept separate from `maybeBuildImageRun` because there's no source
 * `<img>` element here — width/height/alt all derive from the render
 * itself, not from author-supplied attributes.
 */
function buildMermaidImageRun(img: ResolvedImage, ctx: BuildCtx): ImageRun {
  let { width, height } = img;
  const maxW = ctx.pageWidthPx;
  if (width > maxW) {
    const scale = maxW / width;
    width = maxW;
    height = Math.round(height * scale);
  }
  return new ImageRun({
    type: img.type,
    data: img.bytes,
    transformation: { width, height },
    altText: {
      title: 'Mermaid diagram',
      description: 'Mermaid diagram',
      name: 'mermaid-diagram',
    },
  } as ConstructorParameters<typeof ImageRun>[0]);
}

function headingLevelOf(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function convertList(
  node: Element,
  ctx: BuildCtx,
  out: FileChild[],
  walk: WalkCtx,
): void {
  const ordered = node.tagName === 'ol';
  const reference = ordered ? 'marginalia-ordered' : 'marginalia-bullet';
  const level = Math.min(walk.listDepth, 5);
  const hangingIndent = pt2twip(18);

  // Left indent (in twips) applied to continuation paragraphs inside
  // a multi-paragraph list item. Matches the bullet's computed
  // indent from `buildNumbering` (`18 * (level + 1)`) minus the
  // hanging prefix, so continuation text aligns flush under the
  // first paragraph's body.
  const continuationIndent = pt2twip(18 * (level + 1));
  let afterTable = walk.afterTable ?? false;

  for (const item of node.children) {
    if (!isElement(item) || item.tagName !== 'li') continue;

    // Walk the <li>'s children in source order. The FIRST chunk of
    // paragraph-ish content carries the list's numbering (the bullet
    // or number); subsequent paragraphs inside the same <li> become
    // continuation paragraphs — same left indent, no numbering — so
    // Word doesn't restart the bullet for each paragraph of a loose
    // list item. Nested lists keep their own recursion at the deeper
    // list depth.
    let firstParaEmitted = false;
    let pendingInline: HastNode[] = [];

    const flushPending = () => {
      if (pendingInline.length === 0) return;
      const children = collectInlineFromMany(pendingInline, ctx, {});
      if (!firstParaEmitted) {
        out.push(
          new Paragraph(
            withParagraphContext(
              {
                numbering: { reference, level },
                ...(walk.blockquoteDepth > 0
                  ? { indent: { left: continuationIndent, hanging: hangingIndent } }
                  : {}),
                spacing: { after: pt2twip(DOCX_LIST_ITEM_SPACING_PT) },
                children,
              },
              ctx,
              { ...walk, afterTable },
            ),
          ),
        );
        firstParaEmitted = true;
      } else {
        out.push(
          new Paragraph(
            withParagraphContext(
              {
                indent: { left: continuationIndent },
                spacing: { after: pt2twip(DOCX_LIST_ITEM_SPACING_PT) },
                children,
              },
              ctx,
              { ...walk, afterTable },
            ),
          ),
        );
      }
      afterTable = false;
      pendingInline = [];
    };

    for (const c of item.children) {
      if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol')) {
        flushPending();
        convertBlock(c, ctx, out, {
          listDepth: walk.listDepth + 1,
          inOrderedList: ordered,
          blockquoteDepth: walk.blockquoteDepth,
          afterTable,
        });
        afterTable = blockEndsWithTable(c);
      } else if (isElement(c) && c.tagName === 'p') {
        // A `<p>` is its own paragraph. Flush anything we've been
        // accumulating (turns into the previous paragraph), then put
        // THIS `<p>`'s content into pendingInline and flush again so
        // it emits as its own paragraph.
        flushPending();
        pendingInline = [...(c.children as HastNode[])];
        flushPending();
      } else {
        // Skip whitespace-only text nodes only when they occur at a
        // block boundary with no accumulated inline content. This still
        // drops HAST formatting artifacts between block-level children,
        // but preserves meaningful inline spacing in tight list items
        // such as `<strong>foo</strong> <em>bar</em>`.
        if (isIgnorableBlockWhitespace(c) && pendingInline.length === 0) continue;
        // Loose inline (tight-list text, inline elements between
        // paragraphs). Accumulate and flush with the next block boundary.
        pendingInline.push(c);
      }
    }
    flushPending();

    // Empty `<li>` still needs to exist so the numbered list stays
    // intact — emit a numbered paragraph with no content.
    if (!firstParaEmitted) {
      out.push(
        new Paragraph(
          withParagraphContext(
            {
              numbering: { reference, level },
              ...(walk.blockquoteDepth > 0
                ? { indent: { left: continuationIndent, hanging: hangingIndent } }
                : {}),
              spacing: { after: pt2twip(DOCX_LIST_ITEM_SPACING_PT) },
              children: [],
            },
            ctx,
            { ...walk, afterTable },
          ),
        ),
      );
      afterTable = false;
    }
  }
}

function buildCodeBlock(node: Element, tokens: ThemeTokens): Paragraph[] {
  // A `<pre>` wraps either a `<code>` (plain) or directly Shiki-produced
  // spans. For each logical line (separated by '\n' in text nodes) we
  // emit one paragraph styled as CodeBlock.
  const inner =
    node.children.length === 1 && isElement(node.children[0]) && node.children[0].tagName === 'code'
      ? (node.children[0] as Element)
      : node;

  const lines = splitCodeLines(inner, tokens);
  if (lines.length === 0) return [new Paragraph({ style: 'CodeBlock', text: '' })];
  return lines.map((runs) => new Paragraph({ style: 'CodeBlock', children: runs }));
}

/**
 * Split Shiki-highlighted HAST into arrays of TextRuns, one array per
 * source line. Each token inherits its Shiki color (via the
 * `--shiki-light: #xxxxxx` inline style) so the DOCX output preserves
 * the highlight palette of the active Shiki theme.
 */
function splitCodeLines(node: Element, tokens: ThemeTokens): TextRun[][] {
  const lines: TextRun[][] = [[]];

  function push(text: string, style: InlineStyle): void {
    if (text === '') return;
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part !== '')
        // Deliberately NOT passing `code: true` here — that flag is
        // for INLINE `<code>` inside a Normal paragraph, where the
        // run has to carry its own mono font + 0.9× size override.
        // Code-block runs live inside a paragraph styled `CodeBlock`
        // which already sets font and size on the style; a run-level
        // override would just show up as "CodeBlock + 11pt" in
        // Word's style inspector.
        lines[lines.length - 1]!.push(new TextRun(runOptions(style, part, tokens)));
      if (i < parts.length - 1) lines.push([]);
    }
  }

  function walk(n: HastNode, style: InlineStyle): void {
    if (isText(n)) {
      push(n.value, style);
      return;
    }
    if (!isElement(n)) return;
    const next = { ...style };
    // Line wrappers (rehype-shiki wraps each source line in a <span class="line">)
    // Flatten them.
    const shikiColor = readShikiColor(n);
    if (shikiColor) next.color = hex(shikiColor);
    for (const c of n.children as HastNode[]) walk(c, next);
  }

  for (const child of node.children as HastNode[]) walk(child, {});

  // Drop trailing empty line (code blocks in HTML frequently end with '\n').
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}

/** Read `color:#xxxxxx` from the inline `style=""` attribute, if present. */
function readShikiColor(el: Element): string | null {
  const style = el.properties?.style;
  if (typeof style !== 'string') return null;
  // Shiki bundles emit either `color:#xxxxxx` or custom-property assignments.
  const m =
    style.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8})/) ??
    style.match(/--shiki-light\s*:\s*(#[0-9a-fA-F]{3,8})/);
  return m ? m[1]! : null;
}

function buildTable(node: Element, ctx: BuildCtx): Table {
  const tokens = ctx.tokens;
  const rows: TableRow[] = [];
  // Matches CSS `tbody tr:nth-child(even)` — header rows don't count
  // toward the stripe parity. Tracked separately from `rows.length`
  // so a `<thead>` doesn't shift every data row's background.
  let bodyRowIndex = 0;
  let headerSeen = false;

  // Heavier bottom border on header cells, matching the CSS `th {
  // border-bottom-width: 2px; border-bottom-color: var(--md-color-fg) }`
  // in the default theme. Size is in eighths of a point; `16` ≈ 2pt.
  const headerBottomBorder = tokens.table.headerUnderline
    ? {
        style: BorderStyle.SINGLE,
        size: 16,
        color: hex(tokens.colors.fg),
      }
    : null;

  function collectRows(parent: Element, isHeader: boolean): void {
    for (const tr of parent.children) {
      if (!isElement(tr) || tr.tagName !== 'tr') continue;
      const cells: TableCell[] = [];
      const isZebraRow = !isHeader && tokens.table.zebra && bodyRowIndex % 2 === 1;
      for (const cell of tr.children) {
        if (!isElement(cell) || (cell.tagName !== 'td' && cell.tagName !== 'th')) continue;
        const isHeaderCell = cell.tagName === 'th' || isHeader;
        const align = readAlign(cell);
        cells.push(
          new TableCell({
            shading: isHeaderCell
              ? { type: ShadingType.CLEAR, fill: hex(tokens.colors.tableStripe), color: 'auto' }
              : isZebraRow
                ? {
                    type: ShadingType.CLEAR,
                    fill: hex(tokens.colors.tableStripe),
                    color: 'auto',
                  }
                : { type: ShadingType.CLEAR, fill: 'auto', color: 'auto' },
            ...(isHeaderCell && headerBottomBorder
              ? { borders: { bottom: headerBottomBorder } }
              : {}),
            children: [
              new Paragraph({
                ...(isHeaderCell ? { style: 'TableHeader' } : {}),
                ...(align ? { alignment: align } : {}),
                spacing: { line: DOCX_BODY_LINE_SPACING },
                children: collectInline(cell, ctx, { bold: isHeaderCell }),
              }),
            ],
          }),
        );
      }
      if (cells.length === 0) continue;
      rows.push(
        new TableRow({
          children: cells,
          ...(isHeader ? { tableHeader: true } : {}),
        }),
      );
      if (!isHeader) bodyRowIndex++;
    }
  }

  for (const section of node.children) {
    if (!isElement(section)) continue;
    if (section.tagName === 'thead') {
      collectRows(section, true);
      headerSeen = true;
    } else if (section.tagName === 'tbody' || section.tagName === 'tfoot') {
      collectRows(section, false);
    } else if (section.tagName === 'tr') {
      // Table without explicit thead/tbody wrappers.
      if (!headerSeen) {
        // First row as header if it has any th cells.
        const hasTh = section.children.some(
          (c) => isElement(c) && c.tagName === 'th',
        );
        if (hasTh) {
          collectRows({ ...node, children: [section] }, true);
          headerSeen = true;
        } else {
          collectRows({ ...node, children: [section] }, false);
        }
      } else {
        collectRows({ ...node, children: [section] }, false);
      }
    }
  }

  const borderColor = hex(tokens.colors.border);
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    },
  });
}

function readAlign(cell: Element): (typeof AlignmentType)[keyof typeof AlignmentType] | null {
  const align = cell.properties?.align;
  if (align === 'right') return AlignmentType.RIGHT;
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'left') return AlignmentType.LEFT;
  return null;
}

// -- Inline collection --------------------------------------------------

function collectInline(node: Parent, ctx: BuildCtx, style: InlineStyle): ParagraphChild[] {
  return collectInlineFromMany(node.children as HastNode[], ctx, style);
}

function collectInlineFromMany(
  nodes: readonly HastNode[],
  ctx: BuildCtx,
  style: InlineStyle,
): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes) walkInline(n, ctx, style, out);
  return out;
}

function walkInline(
  n: HastNode,
  ctx: BuildCtx,
  style: InlineStyle,
  out: ParagraphChild[],
): void {
  const tokens = ctx.tokens;
  if (isText(n)) {
    if (n.value === '') return;
    out.push(new TextRun(runOptions(style, n.value, tokens)));
    return;
  }
  if (!isElement(n)) return;

  const t = n.tagName;
  switch (t) {
    case 'strong':
    case 'b':
      return walkChildren(n, ctx, { ...style, bold: true }, out);
    case 'em':
    case 'i':
      return walkChildren(n, ctx, { ...style, italic: true }, out);
    case 'del':
    case 's':
    case 'strike':
      return walkChildren(n, ctx, { ...style, strike: true }, out);
    case 'code':
      return walkChildren(
        n,
        ctx,
        {
          ...style,
          code: true,
          font: tokens.fonts.mono.families[0] ?? 'monospace',
          bg: tokens.colors.codeBg,
          color: style.color ?? tokens.colors.codeFg,
        },
        out,
      );
    case 'a': {
      const href = String(n.properties?.href ?? '');
      if (!href) return walkChildren(n, ctx, style, out);
      // Skip heading-anchor sigils (they're UI chrome, not content).
      if (
        Array.isArray(n.properties?.className) &&
        (n.properties.className as unknown[]).includes('heading-anchor')
      ) {
        return;
      }
      // GFM footnote reference: `<sup><a href="#user-content-fn-X"
      // data-footnote-ref>…</a></sup>`. Emit a native DOCX footnote
      // reference instead of an internal hyperlink — Word renders it
      // as a superscript number that auto-numbers and links to the
      // footnote at the bottom of the page.
      if (n.properties?.['dataFootnoteRef'] !== undefined) {
        const slug = stripFootnotePrefix(href.replace(/^#/, '')) ?? '';
        const fnId = ctx.footnoteIds.get(slug);
        if (fnId !== undefined) {
          out.push(new FootnoteReferenceRun(fnId));
          return;
        }
        // Unknown ref — fall through and let the default link handler
        // render it as a dead internal link, which is still better
        // than silently dropping user content.
      }
      // GFM footnote back-reference (`↩`): these only make sense in
      // HTML (a click target to return to the ref). In DOCX the user
      // navigates via Word's own footnote machinery, so drop them to
      // avoid a stray arrow in the footnote text.
      if (n.properties?.['dataFootnoteBackref'] !== undefined) {
        return;
      }
      // Color + underline make the link visually recognisable in
      // Word. Matches the default hyperlink treatment Word applies
      // to its own "Insert > Hyperlink" output — without these,
      // internal links in particular just look like blue text.
      const linkStyle: InlineStyle = {
        ...style,
        color: tokens.colors.accent,
        underline: { color: tokens.colors.accent },
      };
      const linkChildren: ParagraphChild[] = [];
      walkChildren(n, ctx, linkStyle, linkChildren);
      const fallbackChildren = [new TextRun(runOptions(linkStyle, href, tokens))];

      if (href.startsWith('#') && href.length > 1) {
        // Internal anchor link — points at a heading bookmark in this
        // same document. Word renders these as clickable navigation
        // inside the doc.
        out.push(
          new InternalHyperlink({
            anchor: href.slice(1),
            children: linkChildren.length > 0 ? linkChildren : fallbackChildren,
          }),
        );
        return;
      }

      out.push(
        new ExternalHyperlink({
          link: href,
          children: linkChildren.length > 0 ? linkChildren : fallbackChildren,
        }),
      );
      return;
    }
    case 'br':
      out.push(new TextRun({ break: 1 }));
      return;
    case 'span':
    case 'mark':
    case 'u': {
      const extra: InlineStyle = t === 'u' ? { ...style } : style;
      return walkChildren(n, ctx, extra, out);
    }
    case 'img': {
      // Inline image: emit a real ImageRun if we resolved it; else
      // fall back to a muted placeholder so the paragraph still reads.
      const run = maybeBuildImageRun(n, ctx);
      if (run) {
        out.push(run);
        return;
      }
      out.push(
        new TextRun(
          runOptions(
            { ...style, italic: true, color: tokens.colors.fgMuted },
            `[image: ${imagePlaceholderLabel(n)}]`,
            tokens,
          ),
        ),
      );
      return;
    }
    default:
      return walkChildren(n, ctx, style, out);
  }
}

function walkChildren(
  n: Element,
  ctx: BuildCtx,
  style: InlineStyle,
  out: ParagraphChild[],
): void {
  for (const c of n.children as HastNode[]) walkInline(c, ctx, style, out);
}

/**
 * Turn our internal InlineStyle + text into docx's IRunOptions. Skipped
 * fields stay undefined so `exactOptionalPropertyTypes: true` is happy.
 */
function runOptions(style: InlineStyle, text: string, tokens: ThemeTokens): IRunOptions {
  const opts: Record<string, unknown> = { text };
  if (style.bold) opts.bold = true;
  if (style.italic) opts.italics = true;
  if (style.strike) opts.strike = true;
  if (style.color) opts.color = hex(style.color);
  if (style.font) opts.font = style.font;
  if (style.size) opts.size = style.size;
  if (style.bg) {
    opts.shading = { type: ShadingType.CLEAR, fill: hex(style.bg), color: 'auto' };
  }
  if (style.underline) {
    // docx accepts `{ type, color }`. `UnderlineType.SINGLE` is the
    // convention for Word hyperlinks — matches the underline Word
    // applies to its own Insert > Hyperlink output.
    opts.underline = {
      type: UnderlineType.SINGLE,
      ...(style.underline.color ? { color: hex(style.underline.color) } : {}),
    };
  }
  if (style.code) {
    // Inline code runs size down slightly, matching the CSS rule
    // `.marginalia :not(pre) > code { font-size: 0.9em }`. The
    // explicit size is only applied for inline code because the
    // containing paragraph's style is Normal — code blocks use the
    // CodeBlock style which already sets the right size, so they
    // don't need a run-level override.
    opts.size = pt2hp(tokens.fontSize.basePt * 0.9);
    opts.font = style.font ?? tokens.fonts.mono.families[0] ?? 'monospace';
  }
  // Deliberately DO NOT set `opts.size` as a catch-all on every run.
  // The document-default style (`styles.default.document.run.size`)
  // applies when there's no override, and the various named
  // paragraph styles (Heading1..6, CodeBlock, TableHeader, …) each
  // define their own run sizes. Setting a run-level size here would
  // override the style and show up as "Heading1 + 12pt" in Word's
  // style inspector, even when the intent is the style alone.
  return opts as IRunOptions;
}

// Silence a type-only export if docx's Paragraph constructor parameter is
// referenced; keeps this module's surface stable for tests.
export type { Document as _DocxDocument };
// Re-export UnderlineType for future link-underline styling work.
export { UnderlineType };
