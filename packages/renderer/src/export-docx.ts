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

import { diffArrays, diffWordsWithSpace } from 'diff';
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
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  InsertedTextRun,
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
  type ICommentOptions,
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

  /**
   * Optional review-mode payload. When set, the exporter folds the
   * supplied threads into the DOCX as native Word features:
   *
   *   - Comment threads → `word/comments.xml` entries anchored to the
   *     block they target. Replies emit as additional flat comments
   *     anchored to the same range, prefixed `↳ Reply by …` (true
   *     threaded replies need a `commentsExtended` part not exposed
   *     by the `docx` library at v9.x).
   *
   *   - Block-level edit proposals → tracked changes (`<w:ins>` /
   *     `<w:del>` runs) attributed to the proposal opener. Single-
   *     paragraph plain-prose tweaks get word-level inline diff via
   *     `tryEmitInlineWordDiff`; structural proposals (multi-paragraph,
   *     headings, lists, tables, anything with inline formatting) use
   *     the whole-block delete + insert two-pass path.
   *
   *   - Whole-document proposals → labeled "Alternative version
   *     proposed by …" appendix appended to the body. The appendix
   *     content is itself a block-level diff (equal blocks plain,
   *     removed in `<w:del>`, added in `<w:ins>`, replacement pairs
   *     through inline word-diff) so reviewers can scan
   *     change-by-change. Above 70% churn the appendix falls back
   *     to wall-to-wall insertion — a near-total rewrite reads
   *     better as one alternative version than as a sea of
   *     revision marks against an unchanged scaffold.
   *
   * When `null`/undefined the exporter behaves exactly as before;
   * the live document is rendered with no review chrome.
   */
  review?: ReviewExportData;
}

// -- Review-mode payloads ----------------------------------------------

/**
 * One person's contribution to a review thread (opener or reply).
 * Mirrors the server's wire shape minus the bits the export doesn't
 * use (capabilities, client_id), so callers don't have to massage the
 * payload before handing it to `exportDocx`.
 */
export interface ReviewComment {
  readonly body: string;
  readonly author: string;
  /** Unix epoch ms. Converted to `Date` when emitted into comments.xml. */
  readonly date: number;
}

/**
 * A review thread to fold into the export. `block_id` should match the
 * `data-block` (or `data-subblock`) id assigned by `remarkBlockIds`;
 * threads with no resolvable block id are dropped silently.
 */
export interface ReviewThread {
  readonly id: string;
  readonly block_id: string | null;
  readonly end_block_id?: string | null;
  /**
   * The substring of the anchored block's text the user originally
   * highlighted. When set and the substring still appears (exactly
   * once) in the rendered block, the exporter wraps just that
   * substring with `<w:commentRange*>` markers instead of the whole
   * paragraph. Stale or ambiguous quotes degrade to the
   * whole-paragraph fallback so the comment still surfaces.
   */
  readonly anchor_quote?: string | null;
  /** Oldest first; index 0 is the opener, the rest are replies. */
  readonly comments: readonly [ReviewComment, ...ReviewComment[]];
  /** Present iff this thread is an edit proposal. */
  readonly proposal?: {
    readonly source_snapshot: string | null;
    readonly proposed_text: string;
    readonly whole_document?: boolean;
  } | null;
  /** Resolved threads are skipped unless `includeResolved` is set. */
  readonly resolved?: boolean;
  readonly resolution_kind?: 'accept' | 'reject' | 'resolve' | null;
}

export interface ReviewExportData {
  readonly threads: readonly ReviewThread[];
  /** Include resolved threads. Default: false. */
  readonly includeResolved?: boolean;
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
  // Build review-mode indexes up-front so the walker can do O(1)
  // lookups by block id. This also pre-parses every proposal's
  // `proposed_text` to HAST so the synchronous walker can render
  // tracked-change content without re-entering the async pipeline.
  const review = await buildReviewState(options.review, hast, options);

  // Resolve images up-front in parallel so the HAST walker can stay
  // synchronous. docx construction is CPU-bound and sync; doing the
  // async I/O here keeps the walker tidy. The image resolve sweeps
  // every HAST that the export will render — main document plus
  // every proposal's parsed `proposed_text` — so an `<img>` inside
  // a proposal renders with real bytes instead of a placeholder.
  //
  // Mermaid resolution is keyed by the per-HAST `data-mermaid-index`
  // numeric, so proposal HASTs would collide with the main document
  // (each plugin pass restarts indices at 0). Resolving mermaid
  // across proposals safely needs an HAST-disambiguating key —
  // tracked separately; for now mermaid only resolves on the main
  // doc and proposal-side mermaid blocks fall back to the labeled-
  // code-block stopgap.
  const proposalHastList = review ? [...review.proposalHasts.values()] : [];
  const [images, mermaidImages] = await Promise.all([
    resolveAllImages([hast, ...proposalHastList], options.resolveAsset),
    resolveAllMermaid(hast, options.resolveMermaid, options.mermaidConcurrency),
  ]);

  // Pull GFM footnotes out of the body: build their DOCX paragraphs,
  // assign each a numeric id, and remove the `<section>` so it won't
  // appear inline. The walker later turns `<sup>` refs into
  // `FootnoteReferenceRun`s pointed at those ids.
  const effectivePageSize = options.pageSize ?? tokens.page.size;
  const paraOpts = new WeakMap<Paragraph, ParagraphOptions>();
  const runOpts = new WeakMap<
    TextRun | InsertedTextRun | DeletedTextRun,
    IRunOptions
  >();
  const ctxWithoutFootnotes: BuildCtx = {
    tokens,
    images,
    mermaidImages,
    pageWidthPx: contentWidthPx(effectivePageSize, tokens.page.marginPt),
    footnoteIds: new Map(),
    paraOpts,
    runOpts,
    review,
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
  const bodyBlocks: FileChild[] =
    !hasMarker && shouldIncludeToc && leadingHeadingIdx < 0
      ? [...tocBlocks, ...body]
      : body;

  // Whole-document proposals are emitted as an "alternative-version"
  // section appended to the body. The appendix content itself is a
  // block-level diff (equal blocks plain, removed blocks in <w:del>,
  // added blocks in <w:ins>) so reviewers can scan change-by-change
  // instead of being shown the entire alternative as wall-to-wall
  // insertion. The original `hast` is passed through so the diff
  // walker can compare block-for-block against the live document.
  const blocks = appendWholeDocProposals(bodyBlocks, hast, ctx);

  const doc = buildDocument(blocks, tokens, options, footnotes.content, {
    language,
    rtl,
    comments: review ? review.commentChildren : [],
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
  roots: HastRoot | readonly HastRoot[],
  resolve: DocxExportOptions['resolveAsset'],
): Promise<Map<string, ResolvedImage | null>> {
  const srcs = new Set<string>();
  // Accept either a single root or a list — proposal HASTs participate
  // in the same resolve pass as the main document so an `<img>` inside
  // a proposed_text or whole-doc appendix renders with real bytes
  // instead of a placeholder.
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    visit(root, 'element', (node: Element) => {
      if (node.tagName !== 'img') return;
      const src = typeof node.properties?.src === 'string' ? node.properties.src : '';
      if (src) srcs.add(src);
    });
  }

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
      out.push(...buildCodeBlock(node, ctx));
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
  /**
   * Comments emitted by the review-mode walker. Empty when no review
   * payload was supplied or no thread anchored to any block. Becomes
   * the `comments` field on the `Document` constructor — docx writes
   * this out as `word/comments.xml` plus the matching relationship
   * entry. Skipped entirely when the array is empty so vanilla
   * exports don't ship an empty comments part.
   */
  readonly comments: readonly ICommentOptions[];
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
  const hasComments = lang.comments.length > 0;
  return new Document({
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.author !== undefined
      ? { creator: options.author, lastModifiedBy: options.author }
      : {}),
    styles: buildStyles(tokens, lang),
    numbering: buildNumbering(),
    ...(hasFootnotes ? { footnotes } : {}),
    ...(hasComments ? { comments: { children: lang.comments } } : {}),
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
  /**
   * Side-table mapping every paragraph emitted via `mkParagraph` to
   * the options it was constructed with. Lets the review-mode
   * post-processing step rebuild paragraphs with comment-range
   * markers spliced into their inline children — the docx Paragraph
   * object's children are private after construction, so reading the
   * options back from this map is the only way to wrap them losslessly.
   */
  readonly paraOpts: WeakMap<Paragraph, ParagraphOptions>;
  /**
   * Companion side-table for `mkRun`-built runs. Lets the
   * substring-precise comment wrapper recover a TextRun's text
   * content (and the IRunOptions used to style it) so it can split
   * the run at character boundaries that fall mid-text.
   */
  readonly runOpts: WeakMap<
    TextRun | InsertedTextRun | DeletedTextRun,
    IRunOptions
  >;
  /**
   * Active revision wrapper, if any. When non-null, every text-run
   * the inline walker emits is wrapped in `InsertedTextRun` /
   * `DeletedTextRun` and attributed to the proposal opener. Set by
   * the proposal-block handler around its delete pass and insert pass.
   */
  revision?: RevisionMode | null;
  /**
   * Pre-resolved review state: per-block thread index, parsed
   * proposal HASTs, the comment-children accumulator that becomes
   * `word/comments.xml`, and revision-id allocators. Null when the
   * caller didn't pass `review` to `exportDocx`.
   */
  readonly review: ReviewState | null;
}

/**
 * Per-block index of review threads plus the bookkeeping the walker
 * uses while emitting them. Built once per export by
 * `buildReviewState` and shared across the whole document.
 *
 * - `commentsByBlockId` / `proposalsByBlockId` key on the same
 *   `data-block`/`data-subblock` ids that `remarkBlockIds` writes
 *   into the HAST. Threads with no resolvable id are dropped.
 * - `wholeDoc` proposals get appended as an "Alternative version"
 *   section at the end of the body — see `appendWholeDocProposals`.
 * - `proposalHasts` carries the HAST parsed from each proposal's
 *   `proposed_text` so the walker can render it inline without
 *   re-entering the async pipeline.
 * - `commentChildren` is the running list passed to docx's `Comments`
 *   collection; the walker pushes into it as it wraps anchored blocks.
 * - `nextCommentId` / `nextRevisionId` are document-scoped counters.
 */
interface ReviewState {
  readonly commentsByBlockId: Map<string, ReviewThread[]>;
  readonly proposalsByBlockId: Map<string, ReviewThread[]>;
  readonly wholeDoc: ReviewThread[];
  readonly proposalHasts: Map<string, HastRoot>;
  readonly commentChildren: ICommentOptions[];
  readonly nextCommentId: { value: number };
  readonly nextRevisionId: { value: number };
}

interface RevisionMode {
  readonly kind: 'insert' | 'delete';
  readonly author: string;
  /** ISO date string. OOXML wants `xsd:dateTime`. */
  readonly date: string;
  /**
   * Single revision id shared by every run emitted during this
   * pass. OOXML / Word groups runs into one Accept/Reject unit by
   * `(w:id, w:author, w:date)` triple — using a different id per
   * run would fragment a single proposal's deletion (or insertion)
   * into N separate revisions in Word's review pane, one per text
   * fragment, which is unusable for accept/reject all. The pass
   * caller allocates one id from `review.nextRevisionId` when
   * entering the mode and passes it through here.
   */
  readonly id: number;
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
  /**
   * Block id whose review wrapping is currently in progress. The
   * wrap helpers re-enter `convertBlock` for the same block to do
   * the inner conversion; this flag tells the entry guard to skip
   * the review check on that recursion and fall through to the
   * normal switch-on-tagName path.
   */
  readonly reviewWrappedBlockId?: string | null;
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
  // Review-mode interception. If the block has an id matching a
  // review thread, route through the wrapping/replacement path
  // instead of normal rendering. The `reviewWrappedBlockId` flag
  // breaks recursion: the wrap helpers re-enter convertBlock for
  // the same block to do the inner conversion, and we don't want
  // to wrap it again.
  if (ctx.review && isElement(node)) {
    const blockId = readDataBlockId(node);
    if (blockId && walk.reviewWrappedBlockId !== blockId) {
      const proposals = ctx.review.proposalsByBlockId.get(blockId) ?? [];
      const comments = ctx.review.commentsByBlockId.get(blockId) ?? [];
      if (proposals.length > 0 || comments.length > 0) {
        const innerWalk: WalkCtx = { ...walk, reviewWrappedBlockId: blockId };
        if (proposals.length > 0) {
          // Pass comment-only threads through so they're attached to
          // the same insertion region and not silently dropped when a
          // block has both a proposal and side discussion.
          emitProposalBlock(node, proposals, comments, ctx, out, innerWalk);
        } else {
          emitCommentedBlock(node, comments, ctx, out, innerWalk);
        }
        return;
      }
    }
  }
  convertBlockInner(node, ctx, out, walk);
}

function convertBlockInner(
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
        mkParagraph(
          withParagraphContext({ children: [mkRun({ text: node.value }, ctx)] }, ctx, walk),
          ctx,
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
        mkParagraph(
          withParagraphContext({ children: collectInline(node, ctx, {}) }, ctx, walk),
          ctx,
        ),
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
      out.push(...buildCodeBlock(node, ctx));
      return;

    case 'table':
      out.push(buildTable(node, ctx));
      return;

    case 'hr':
      out.push(
        mkParagraph(
          {
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
          },
          ctx,
        ),
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
            mkParagraph(
              {
                alignment: AlignmentType.CENTER,
                children: [run],
              },
              ctx,
            ),
          );
          return;
        }
        const source = hastTextContent(node);
        out.push(
          mkParagraph(
            {
              children: [
                mkRun(
                  {
                    text: '◇ mermaid diagram',
                    italics: true,
                    color: hex(tokens.colors.fgMuted),
                  },
                  ctx,
                ),
              ],
            },
            ctx,
          ),
        );
        for (const line of source.split('\n')) {
          out.push(
            mkParagraph(
              {
                style: 'CodeBlock',
                children: [mkRun({ text: line }, ctx)],
              },
              ctx,
            ),
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
          out.push(
            mkParagraph(withParagraphContext({ children: inline }, ctx, walk), ctx),
          );
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
  return mkParagraph(
    {
      style: styleId,
      heading: headingLevelOf(level),
      children,
    },
    ctx,
  );
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
    return mkParagraph(
      {
        alignment: AlignmentType.CENTER,
        children: [run],
      },
      ctx,
    );
  }
  // Unresolvable → placeholder paragraph (same visual as a broken
  // inline image, but promoted to a full paragraph since that's the
  // context we're in).
  return mkParagraph(
    {
      children: [
        mkRun(
          {
            text: `[image: ${imagePlaceholderLabel(node)}]`,
            italics: true,
            color: hex(ctx.tokens.colors.fgMuted),
          },
          ctx,
        ),
      ],
    },
    ctx,
  );
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
          mkParagraph(
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
            ctx,
          ),
        );
        firstParaEmitted = true;
      } else {
        out.push(
          mkParagraph(
            withParagraphContext(
              {
                indent: { left: continuationIndent },
                spacing: { after: pt2twip(DOCX_LIST_ITEM_SPACING_PT) },
                children,
              },
              ctx,
              { ...walk, afterTable },
            ),
            ctx,
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
        mkParagraph(
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
          ctx,
        ),
      );
      afterTable = false;
    }
  }
}

function buildCodeBlock(node: Element, ctx: BuildCtx): Paragraph[] {
  // A `<pre>` wraps either a `<code>` (plain) or directly Shiki-produced
  // spans. For each logical line (separated by '\n' in text nodes) we
  // emit one paragraph styled as CodeBlock.
  const inner =
    node.children.length === 1 && isElement(node.children[0]) && node.children[0].tagName === 'code'
      ? (node.children[0] as Element)
      : node;

  const lines = splitCodeLines(inner, ctx);
  if (lines.length === 0) return [mkParagraph({ style: 'CodeBlock', text: '' }, ctx)];
  return lines.map((runs) => mkParagraph({ style: 'CodeBlock', children: runs }, ctx));
}

/**
 * Split Shiki-highlighted HAST into arrays of runs, one array per
 * source line. Each token inherits its Shiki color (via the
 * `--shiki-light: #xxxxxx` inline style) so the DOCX output preserves
 * the highlight palette of the active Shiki theme. Runs route through
 * `mkRun` so they participate in the active tracked-change pass when
 * the code block is part of an edit proposal.
 */
function splitCodeLines(
  node: Element,
  ctx: BuildCtx,
): (TextRun | InsertedTextRun | DeletedTextRun)[][] {
  const tokens = ctx.tokens;
  const lines: (TextRun | InsertedTextRun | DeletedTextRun)[][] = [[]];

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
        lines[lines.length - 1]!.push(mkRun(runOptions(style, part, tokens), ctx));
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
    out.push(mkRun(runOptions(style, n.value, tokens), ctx));
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
      const fallbackChildren = [mkRun(runOptions(linkStyle, href, tokens), ctx)];

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
      out.push(mkRun({ break: 1 }, ctx));
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
        mkRun(
          runOptions(
            { ...style, italic: true, color: tokens.colors.fgMuted },
            `[image: ${imagePlaceholderLabel(n)}]`,
            tokens,
          ),
          ctx,
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

// -- Review-mode helpers -----------------------------------------------

/**
 * Track a Paragraph's options at construction time so the review-mode
 * post-processor can rebuild it with comment-range markers spliced in
 * later. docx Paragraphs are sealed after construction; without this
 * side-table the only ways to "wrap" them would be (a) `addRunToFront`
 * (which is start-only and can't take CommentRange* nodes) or
 * (b) emitting extra blank marker paragraphs (which produce visible
 * spacing in Word).
 *
 * Only call sites for paragraphs the review walker can wrap should go
 * through here. Paragraphs that exist purely as internal structure —
 * TOC blocks, footnote bodies, table cell contents — bypass this
 * helper because they're never the wrap target themselves.
 */
function mkParagraph(opts: ParagraphOptions, ctx: BuildCtx): Paragraph {
  const p = new Paragraph(opts);
  ctx.paraOpts.set(p, opts);
  return p;
}

/**
 * Build a TextRun, wrapping it in `InsertedTextRun` / `DeletedTextRun`
 * when the walker is currently inside a tracked-change pass. Every
 * wrapped run reuses the single revision id the caller stashed on
 * `ctx.revision.id` when it entered the pass — Word groups runs
 * sharing `(w:id, w:author, w:date)` into one Accept/Reject unit,
 * and a structural delete/insert is one logical change, not one per
 * text fragment. Allocation of that id (one per pass, drawn from
 * `review.nextRevisionId`) is the caller's responsibility.
 *
 * Behaves identically to `new TextRun(opts)` outside revision mode,
 * so call sites can route through it unconditionally.
 */
function mkRun(
  opts: IRunOptions,
  ctx: BuildCtx,
): TextRun | InsertedTextRun | DeletedTextRun {
  const rev = ctx.revision;
  let run: TextRun | InsertedTextRun | DeletedTextRun;
  if (!rev) {
    run = new TextRun(opts);
  } else {
    const attrs = { id: rev.id, author: rev.author, date: rev.date };
    run =
      rev.kind === 'insert'
        ? new InsertedTextRun({ ...attrs, ...opts })
        : new DeletedTextRun({ ...attrs, ...opts });
  }
  // Stash the source options so the substring-precise comment
  // wrapper can read the run's text back and split it at character
  // boundaries that fall mid-text.
  ctx.runOpts.set(run, opts);
  return run;
}

/** Read the `data-block` id off a HAST element, if any. Empty → null. */
function readDataBlockId(node: Element): string | null {
  const props = node.properties ?? {};
  const raw = (props as Record<string, unknown>)['dataBlock'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Read the `data-subblock` id off a HAST element, if any. */
function readDataSubBlockId(node: Element): string | null {
  const props = node.properties ?? {};
  const raw = (props as Record<string, unknown>)['dataSubblock'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Pre-resolve the review payload into the indexes the synchronous
 * walker reads from. Threads with no anchor block id are dropped
 * (we have nowhere to attach them); resolved threads are dropped
 * unless `includeResolved` is set.
 *
 * Threads anchored to a sub-block (list item, table cell) are
 * promoted to their enclosing top-level block's index. Sub-block
 * granularity inside Word would require splitting list/table cell
 * content along run boundaries, which is more invasive than v1
 * scope; the parent-block fallback keeps the comment near the
 * right text without tearing the structure.
 *
 * For each proposal we also pre-parse the `proposed_text` through
 * the same markdown→HAST pipeline as the main document so the
 * walker can emit it inline as InsertedTextRun-wrapped paragraphs
 * during the proposal's "insert pass" without re-entering the
 * async machinery.
 */
async function buildReviewState(
  reviewData: ReviewExportData | undefined,
  hast: HastRoot,
  options: DocxExportOptions,
): Promise<ReviewState | null> {
  if (!reviewData || reviewData.threads.length === 0) return null;

  const includeResolved = reviewData.includeResolved === true;
  const filtered = reviewData.threads.filter(
    (t) => includeResolved || !t.resolved,
  );
  if (filtered.length === 0) return null;

  // Sub-block id → top-level block id, so sub-block-anchored threads
  // can promote up. Built by walking the HAST once.
  const subToParent = buildSubBlockParentIndex(hast);

  const commentsByBlockId = new Map<string, ReviewThread[]>();
  const proposalsByBlockId = new Map<string, ReviewThread[]>();
  const wholeDoc: ReviewThread[] = [];
  const proposalHasts = new Map<string, HastRoot>();

  for (const thread of filtered) {
    let isProposal = !!thread.proposal;

    if (isProposal && thread.proposal!.whole_document) {
      wholeDoc.push(thread);
      const parsed = await sourceToHast(
        thread.proposal!.proposed_text,
        options.format ?? 'markdown',
        {
          ...(options.highlight !== undefined ? { highlight: options.highlight } : {}),
        },
      );
      proposalHasts.set(thread.id, parsed.hast);
      continue;
    }

    // Multi-block proposals span from `block_id` through
    // `end_block_id`. The walker would render the first block as
    // delete/insert and leave the remaining original blocks in
    // place — duplicating content and misrepresenting the proposal.
    // Demote to a comment-only entry so the discussion still
    // surfaces while the body text stays correct. Multi-block
    // span replacement is a separate piece of work.
    if (
      isProposal &&
      thread.end_block_id &&
      thread.end_block_id !== thread.block_id
    ) {
      isProposal = false;
    }

    const rawId = thread.block_id;
    if (!rawId) continue;
    // Promote sub-block anchors to their parent block.
    const blockId = subToParent.get(rawId) ?? rawId;
    const target = isProposal ? proposalsByBlockId : commentsByBlockId;
    const list = target.get(blockId);
    if (list) list.push(thread);
    else target.set(blockId, [thread]);

    if (isProposal) {
      const parsed = await sourceToHast(
        thread.proposal!.proposed_text,
        options.format ?? 'markdown',
        {
          ...(options.highlight !== undefined ? { highlight: options.highlight } : {}),
        },
      );
      proposalHasts.set(thread.id, parsed.hast);
    }
  }

  return {
    commentsByBlockId,
    proposalsByBlockId,
    wholeDoc,
    proposalHasts,
    commentChildren: [],
    nextCommentId: { value: 1 },
    nextRevisionId: { value: 1 },
  };
}

/**
 * Walk the HAST once, return a map from each `data-subblock` id to
 * its enclosing top-level `data-block` id. Threads anchored to a
 * sub-block (list item, table cell) use this to promote up to the
 * parent block's wrap point.
 */
function buildSubBlockParentIndex(root: HastRoot): Map<string, string> {
  const out = new Map<string, string>();
  function walk(node: HastNode, parentBlockId: string | null): void {
    if (!isElement(node)) return;
    const id = readDataBlockId(node);
    const sub = readDataSubBlockId(node);
    const nextParent = id ?? parentBlockId;
    if (sub && nextParent) out.set(sub, nextParent);
    for (const c of node.children as HastNode[]) walk(c, nextParent);
  }
  for (const c of root.children as HastNode[]) walk(c, null);
  return out;
}

/**
 * Allocate a comment id and push the rendered Comment payload onto
 * the document's comments-children accumulator. Replies render as
 * additional flat comments anchored to the same block-level range,
 * each with `↳ Reply by …` prefixed to the body — the docx library
 * at v9.x doesn't expose `commentsExtended.xml`, which is what Word
 * needs to render true threaded replies in the review pane. Flat
 * fallback keeps the conversation visible without requiring a raw
 * OOXML post-processing pass.
 */
function allocCommentIdsForThread(thread: ReviewThread, ctx: BuildCtx): number[] {
  const review = ctx.review!;
  const ids: number[] = [];
  for (let i = 0; i < thread.comments.length; i++) {
    const c = thread.comments[i]!;
    const id = review.nextCommentId.value++;
    ids.push(id);
    const isOpener = i === 0;
    const body = isOpener ? c.body : `↳ Reply by ${c.author}: ${c.body}`;
    const initials = makeInitials(c.author);
    const opt: ICommentOptions = {
      id,
      author: c.author,
      date: new Date(c.date),
      ...(initials ? { initials } : {}),
      children: [new Paragraph({ children: [new TextRun({ text: body })] })],
    };
    review.commentChildren.push(opt);
  }
  return ids;
}

/** Best-effort 2–3 letter initials from a display name. */
function makeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Wrap a contiguous range of paragraphs with comment-range markers
 * for one or more comment ids. The first paragraph in the range gets
 * each `CommentRangeStart` prepended; the last paragraph gets each
 * `CommentRangeEnd` and `CommentReference` appended.
 *
 * Non-Paragraph FileChildren (Tables, TableOfContents) inside the
 * range are passed through unchanged — wrapping them would require
 * descending into the cells. The first/last *Paragraph* in the range
 * is used as the wrap point instead, which keeps the comment near
 * the right text for tables without tearing the cell structure.
 *
 * Returns a fresh array; original paragraphs whose options can be
 * recovered via `ctx.paraOpts` are rebuilt with augmented children.
 */
function wrapBufferWithCommentRanges(
  buf: FileChild[],
  commentIds: readonly number[],
  ctx: BuildCtx,
): FileChild[] {
  if (commentIds.length === 0) return buf;
  const starts = commentIds.map((id) => new CommentRangeStart(id));
  const ends = commentIds.flatMap((id) => [
    new CommentRangeEnd(id),
    new CommentReference(id),
  ]);

  // Find the first and last Paragraph in the buffer — those are the
  // wrap points. Tables / TOC fields can't host CommentRange* nodes
  // directly (they're ParagraphChildren), so we anchor on adjacent
  // paragraphs instead of descending into cells.
  let firstP = -1;
  let lastP = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] instanceof Paragraph) {
      if (firstP === -1) firstP = i;
      lastP = i;
    }
  }

  // No paragraph in the buffer (e.g. comment anchored to a table-only
  // block). Emit a synthetic empty marker paragraph carrying both
  // ends so the comment still has an anchor in the doc — Word shows
  // it as a tiny visual marker rather than dropping the comment to
  // an orphan in the review pane.
  if (firstP === -1) {
    return [
      ...buf,
      mkParagraph({ children: [...starts, ...ends] }, ctx),
    ];
  }

  const out = [...buf];
  if (firstP === lastP) {
    // Single paragraph: prepend starts and append ends in one rebuild
    // so the second augment doesn't overwrite the first.
    out[firstP] = augmentParagraph(buf[firstP] as Paragraph, ctx, {
      prepend: starts,
      append: ends,
    });
  } else {
    out[firstP] = augmentParagraph(buf[firstP] as Paragraph, ctx, {
      prepend: starts,
    });
    out[lastP] = augmentParagraph(buf[lastP] as Paragraph, ctx, {
      append: ends,
    });
  }
  return out;
}

/**
 * Rebuild a Paragraph with extra inline children prepended/appended.
 * Reads the original options out of the side-table populated by
 * `mkParagraph`. Falls back to the original Paragraph if no options
 * were recorded (e.g. the paragraph came from a code path that
 * bypassed `mkParagraph`); the comment range markers are then
 * silently dropped for that paragraph rather than throwing — losing
 * one comment anchor is better than failing the whole export.
 */
function augmentParagraph(
  p: Paragraph,
  ctx: BuildCtx,
  patch: {
    prepend?: readonly ParagraphChild[];
    append?: readonly ParagraphChild[];
  },
): Paragraph {
  const opts = ctx.paraOpts.get(p);
  if (!opts) return p;
  const original = (opts.children ?? []) as ParagraphChild[];
  const next: ParagraphChild[] = [
    ...(patch.prepend ?? []),
    ...original,
    ...(patch.append ?? []),
  ];
  return mkParagraph({ ...opts, children: next }, ctx);
}

/**
 * Render a block targeted by one or more comment threads. The block
 * is converted normally into a fresh sub-buffer; each thread is
 * then wrapped in turn, preferring substring-precise wrap when
 * the thread carries an `anchor_quote` that still appears (exactly
 * once) in the rendered block. Threads that can't be placed
 * precisely fall back to the whole-block wrap.
 *
 * Per-thread wrapping is incremental: each iteration mutates the
 * sub-buffer with that thread's comment range markers, and the
 * next iteration sees those markers as already-present children.
 * Comment ranges in OOXML are allowed to overlap arbitrarily, so
 * stacking them is safe.
 */
function emitCommentedBlock(
  node: Element,
  threads: readonly ReviewThread[],
  ctx: BuildCtx,
  out: FileChild[],
  walk: WalkCtx,
): void {
  let sub: FileChild[] = [];
  convertBlockInner(node, ctx, sub, walk);
  for (const t of threads) {
    const ids = allocCommentIdsForThread(t, ctx);
    const quote = t.anchor_quote ?? null;
    const precise =
      quote && quote.length > 0
        ? tryWrapBufferAtSubstring(sub, quote, ids, ctx)
        : null;
    sub = precise ?? wrapBufferWithCommentRanges(sub, ids, ctx);
  }
  out.push(...sub);
}

/**
 * Try to wrap a substring of the sub-buffer's first Paragraph with
 * comment range markers. Returns a fresh buffer when:
 *
 *   - the buffer's first FileChild is a Paragraph,
 *   - the paragraph's children come from `mkParagraph` (so the
 *     options are recoverable from `ctx.paraOpts`),
 *   - the concatenation of TextRun text contains the substring
 *     exactly once (>1 occurrences would be ambiguous),
 *   - and every child the substring touches is a TextRun whose
 *     `IRunOptions` are recoverable from `ctx.runOpts` (so we can
 *     split it at character boundaries while keeping its style).
 *
 * Returns null when any of those conditions fails — the caller
 * falls back to whole-paragraph wrap so the comment still surfaces.
 */
function tryWrapBufferAtSubstring(
  buf: readonly FileChild[],
  substring: string,
  commentIds: readonly number[],
  ctx: BuildCtx,
): FileChild[] | null {
  if (buf.length === 0 || commentIds.length === 0) return null;
  const first = buf[0];
  if (!(first instanceof Paragraph)) return null;
  const opts = ctx.paraOpts.get(first);
  if (!opts || !opts.children) return null;
  const children = opts.children as ParagraphChild[];

  // Build a flat list of (childIndex, textOffsetInsideChild, char) for
  // every text-bearing child — we need character-level addressing
  // across the run sequence to find the substring's boundaries.
  interface Slot {
    readonly childIndex: number;
    readonly text: string;
    readonly runOpts: IRunOptions;
  }
  const slots: Slot[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (
      c instanceof TextRun ||
      c instanceof InsertedTextRun ||
      c instanceof DeletedTextRun
    ) {
      const ro = ctx.runOpts.get(c);
      if (!ro || typeof ro.text !== 'string') return null; // unrecoverable
      slots.push({ childIndex: i, text: ro.text, runOpts: ro });
    } else {
      // Non-text child (Bookmark, ExternalHyperlink, ImageRun, …).
      // Mark with empty text so we still preserve the child in the
      // rebuild — but if the substring touches it, give up.
      slots.push({ childIndex: i, text: '', runOpts: { text: '' } });
    }
  }

  const concatenated = slots.map((s) => s.text).join('');
  const firstHit = concatenated.indexOf(substring);
  if (firstHit === -1) return null;
  const lastHit = concatenated.lastIndexOf(substring);
  if (lastHit !== firstHit) return null; // ambiguous — multiple matches
  const startOffset = firstHit;
  const endOffset = firstHit + substring.length;

  // Locate (slotIndex, intra-slot offset) for both ends.
  function locate(globalOffset: number): { slot: number; intra: number } | null {
    let acc = 0;
    for (let s = 0; s < slots.length; s++) {
      const t = slots[s]!.text;
      if (globalOffset <= acc + t.length) {
        return { slot: s, intra: globalOffset - acc };
      }
      acc += t.length;
    }
    return null;
  }
  const startLoc = locate(startOffset);
  const endLoc = locate(endOffset);
  if (!startLoc || !endLoc) return null;

  // Refuse if either end falls inside a non-text-bearing slot (we
  // can't split a Bookmark or ImageRun mid-character).
  const slotIsTextBearing = (s: Slot): boolean => s.text.length > 0;
  if (
    (startLoc.intra > 0 && startLoc.intra < (slots[startLoc.slot]?.text.length ?? 0)) ||
    (endLoc.intra > 0 && endLoc.intra < (slots[endLoc.slot]?.text.length ?? 0))
  ) {
    if (
      !slotIsTextBearing(slots[startLoc.slot]!) ||
      !slotIsTextBearing(slots[endLoc.slot]!)
    ) {
      return null;
    }
  }

  // Rebuild the paragraph's children with the markers spliced in.
  const starts = commentIds.map((id) => new CommentRangeStart(id));
  const ends = commentIds.flatMap((id) => [
    new CommentRangeEnd(id),
    new CommentReference(id),
  ]);

  const newChildren: ParagraphChild[] = [];
  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s]!;
    const childIdx = slot.childIndex;
    const child = children[childIdx]!;
    const isTextRun =
      child instanceof TextRun ||
      child instanceof InsertedTextRun ||
      child instanceof DeletedTextRun;

    if (!isTextRun || slot.text.length === 0) {
      // Non-text passthrough.
      newChildren.push(child);
      continue;
    }

    // Compute split points within this slot.
    const cutStart = s === startLoc.slot ? startLoc.intra : null;
    const cutEnd = s === endLoc.slot ? endLoc.intra : null;
    const text = slot.text;

    if (cutStart === null && cutEnd === null) {
      // Slot is entirely outside or entirely inside the comment range.
      // (Inside is handled by the wrap markers placed at boundaries.)
      newChildren.push(child);
      continue;
    }

    // Build up to three pieces from this run, with markers between them.
    const before = text.slice(0, cutStart ?? text.length);
    const middle = text.slice(cutStart ?? 0, cutEnd ?? text.length);
    const after = text.slice(cutEnd ?? text.length);

    if (before.length > 0)
      newChildren.push(mkPlainTextRun({ ...slot.runOpts, text: before }, ctx));
    if (cutStart !== null) newChildren.push(...starts);
    if (middle.length > 0)
      newChildren.push(mkPlainTextRun({ ...slot.runOpts, text: middle }, ctx));
    if (cutEnd !== null) newChildren.push(...ends);
    if (after.length > 0)
      newChildren.push(mkPlainTextRun({ ...slot.runOpts, text: after }, ctx));
  }

  const newPara = mkParagraph({ ...opts, children: newChildren }, ctx);
  return [newPara, ...buf.slice(1)];
}

/**
 * Construct a plain `TextRun` and register its options in
 * `ctx.runOpts` so a subsequent precise-wrap pass on the same
 * paragraph can recover its text and split it again. `mkRun`
 * would also wrap the run in InsertedTextRun/DeletedTextRun if
 * we happened to be inside a revision pass; this helper is for
 * the post-walk wrap path where revision attribution doesn't
 * apply.
 */
function mkPlainTextRun(opts: IRunOptions, ctx: BuildCtx): TextRun {
  const run = new TextRun(opts);
  ctx.runOpts.set(run, opts);
  return run;
}

/**
 * Render an edit-proposal block as Word tracked changes. Emits the
 * original block in DELETE mode (every text run wrapped in
 * `<w:del>`) followed by the proposed text in INSERT mode
 * (`<w:ins>`). The proposal opener is set as the change author.
 *
 * Multiple proposals targeting the same block use the FIRST proposal
 * as the active one; the others render as flat comments attached to
 * the inserted region — overlapping `<w:ins>` from different authors
 * tends to confuse Word's "Accept/Reject all" UI, so we explicitly
 * serialize them.
 *
 * `extraComments` carries comment-only threads anchored to the same
 * block so they're not dropped when a block has both a proposal and
 * a side discussion. They're attached to the inserted region with
 * the same flat-comments treatment.
 *
 * The thread body (and any replies) are emitted as a Word comment
 * anchored to the inserted-text region so reviewers can see the
 * rationale alongside the change in the comment pane.
 *
 * If the proposal's `proposed_text` couldn't be pre-parsed (rare —
 * branch ref orphaned, parse failed), we degrade to rendering the
 * original block normally and attaching the thread bodies as
 * comments. Showing struck-through original with no replacement
 * would just confuse reviewers.
 */
function emitProposalBlock(
  node: Element,
  proposals: readonly ReviewThread[],
  extraComments: readonly ReviewThread[],
  ctx: BuildCtx,
  out: FileChild[],
  walk: WalkCtx,
): void {
  const review = ctx.review!;
  const main = proposals[0]!;
  const propHast = review.proposalHasts.get(main.id);

  // Fallback path: no parsed proposed-text HAST available. Render
  // the block normally and attach all related threads as comments
  // so the discussion is still visible.
  if (!propHast) {
    emitCommentedBlock(node, [...proposals, ...extraComments], ctx, out, walk);
    return;
  }

  const opener = main.comments[0];
  const author = opener.author || 'Markdowner reviewer';
  const date = new Date(opener.date).toISOString();

  // Inline word-level diff path (Word's "Suggestions" UX): when the
  // proposal sits inside a single plain-prose paragraph on both
  // sides, splice ins/del runs at word boundaries instead of
  // emitting two whole replacement blocks. Catches the common
  // wording-tweak case where the author changed a few words and we
  // want Word to highlight just those.
  //
  // Falls through to the structural two-pass path below for
  // anything that isn't simple prose: headings, lists, code blocks,
  // tables, multi-paragraph proposals, or any source/proposed text
  // that contains markdown formatting we'd lose by flattening.
  const inlineRuns = tryEmitInlineWordDiff(
    node,
    main,
    propHast,
    author,
    date,
    ctx,
    walk,
  );
  if (inlineRuns) {
    const commentIds: number[] = [];
    for (const t of proposals) commentIds.push(...allocCommentIdsForThread(t, ctx));
    for (const t of extraComments)
      commentIds.push(...allocCommentIdsForThread(t, ctx));
    const para = mkParagraph(
      withParagraphContext({ children: inlineRuns }, ctx, walk),
      ctx,
    );
    out.push(...wrapBufferWithCommentRanges([para], commentIds, ctx));
    return;
  }

  // Pass 1: original block, every text run wrapped in DeletedTextRun.
  // One revision id for the whole pass — Word groups (id, author,
  // date) into a single Accept/Reject unit, and a structural
  // proposal IS one logical change, not one per text fragment.
  const ctxDel: BuildCtx = {
    ...ctx,
    revision: {
      kind: 'delete',
      author,
      date,
      id: review.nextRevisionId.value++,
    },
  };
  const delBuf: FileChild[] = [];
  convertBlockInner(node, ctxDel, delBuf, walk);
  out.push(...delBuf);

  // Pass 2: proposed_text (pre-parsed to HAST), every text run
  // wrapped in InsertedTextRun. `review: null` disables the
  // block-id review interception during this sub-walk — the
  // proposed-text HAST gets `data-block` ids assigned by
  // `remarkBlockIds`, and those ids hash the plain-text content
  // (no markdown formatting), so a proposal that doesn't change
  // the visible text would collide with the original block id and
  // recurse into emitProposalBlock forever.
  const ctxIns: BuildCtx = {
    ...ctx,
    revision: {
      kind: 'insert',
      author,
      date,
      id: review.nextRevisionId.value++,
    },
    review: null,
  };
  const insBuf: FileChild[] = hastToDocxChildren(propHast, ctxIns, {});

  // Attach the thread's comments to the inserted region (last
  // paragraph) so the rationale is visible. Replies become flat
  // additional comments — same range, "↳ Reply by …" prefix.
  const commentIds: number[] = [];
  for (const t of proposals) commentIds.push(...allocCommentIdsForThread(t, ctx));
  for (const t of extraComments)
    commentIds.push(...allocCommentIdsForThread(t, ctx));
  out.push(...wrapBufferWithCommentRanges(insBuf, commentIds, ctx));
}

/**
 * Try to emit an inline word-level diff for a small wording-tweak
 * proposal. Returns the diff-spliced ParagraphChild list when the
 * proposal qualifies, or null when the structural two-pass path
 * should handle it.
 *
 * Qualifies when ALL of:
 *  - The original block is a single `<p>` (paragraph) — not a
 *    heading, list, table, code block, blockquote, etc.
 *  - The proposed text parses to a single paragraph too.
 *  - Both sides contain only inline text (no `<strong>`, `<em>`,
 *    `<a>`, `<code>`, `<img>`, etc.) — interleaving word-level
 *    ins/del with formatting boundaries would require a much more
 *    careful structural alignment.
 *
 * The diff itself is `diffWordsWithSpace`, which keeps whitespace as
 * separate change tokens — gives Word's reviewer a tighter visual
 * "added X / removed Y" pair than `diffWords` (which conflates
 * adjacent whitespace into the surrounding word).
 */
function tryEmitInlineWordDiff(
  node: Element,
  _thread: ReviewThread,
  propHast: HastRoot,
  author: string,
  date: string,
  ctx: BuildCtx,
  _walk: WalkCtx,
): ParagraphChild[] | null {
  // Original side: must be a single <p> with only inline text content.
  if (node.tagName !== 'p') return null;
  const oldText = pureTextContent(node);
  if (oldText === null) return null;

  // Proposed side: must be a single <p> after the markdown→HAST
  // pipeline, with only inline text content.
  const propPara = singleParagraphElement(propHast);
  if (!propPara) return null;
  const newText = pureTextContent(propPara);
  if (newText === null) return null;

  // No-op proposal — punt to the structural path so it still emits
  // ins/del attribution rather than silently rendering as plain text.
  if (oldText === newText) return null;

  // Diff the rendered text on both sides — NOT the proposal's
  // raw `source_snapshot`/`proposed_text` source slices. The
  // qualification check above used `oldText` from the live HAST,
  // and the unchanged segments emit as plain `<w:r>` runs that
  // sit inline in the body, so they have to match what the live
  // doc shows. If we diffed `source_snapshot` instead, a stale
  // snapshot (proposal authored against an older revision of the
  // block) would emit equal runs that contradict the live doc.
  return runsForInlineWordDiff(oldText, newText, author, date, ctx);
}

/**
 * Apply jsdiff's word-with-space diff to two plain-text strings
 * and emit the resulting sequence as a flat ParagraphChild list:
 *
 *   - unchanged tokens become normal `TextRun`s,
 *   - removed tokens become `DeletedTextRun`s,
 *   - added tokens become `InsertedTextRun`s.
 *
 * One revision id is allocated for the whole diff and shared
 * across every ins/del run it emits, so Word groups them under
 * one Accept/Reject unit instead of N separate revisions per
 * word — matching what the structural delete/insert pass does.
 */
function runsForInlineWordDiff(
  oldText: string,
  newText: string,
  author: string,
  date: string,
  ctx: BuildCtx,
): ParagraphChild[] {
  const review = ctx.review!;
  // One id for the whole inline diff. Word groups runs sharing
  // the same (id, author, date) into a single Accept/Reject unit;
  // a fresh id per token would shatter one logical wording tweak
  // into one revision per word.
  const id = review.nextRevisionId.value++;
  const attrs = { id, author, date };
  const out: ParagraphChild[] = [];
  for (const change of diffWordsWithSpace(oldText, newText)) {
    if (change.value === '') continue;
    if (change.added) {
      out.push(new InsertedTextRun({ ...attrs, text: change.value }));
    } else if (change.removed) {
      out.push(new DeletedTextRun({ ...attrs, text: change.value }));
    } else {
      out.push(new TextRun({ text: change.value }));
    }
  }
  return out;
}

/**
 * Plain-text content of a HAST element, but only when the element
 * contains exclusively text and `<br>` nodes (no inline formatting).
 * Returns null if any other element is encountered — the inline-diff
 * path bails out in that case rather than silently dropping the
 * formatting.
 */
function pureTextContent(node: Element): string | null {
  let out = '';
  for (const child of node.children as HastNode[]) {
    if (isText(child)) {
      out += child.value;
    } else if (isElement(child) && child.tagName === 'br') {
      out += '\n';
    } else {
      return null;
    }
  }
  return out;
}

/**
 * If a HAST root reduces to exactly one `<p>` element (after peeling
 * the usual `<html>`/`<body>` wrappers from `rehype-raw`), return it.
 * Otherwise return null — the inline-diff path requires both sides
 * to be a single paragraph for word-level alignment to make sense.
 */
function singleParagraphElement(root: HastRoot): Element | null {
  const top = flattenRoot(root);
  // Skip whitespace-only text nodes between blocks.
  const meaningful = top.filter(
    (n) => !(isText(n) && n.value.trim() === ''),
  );
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (!only || !isElement(only) || only.tagName !== 'p') return null;
  return only;
}

/**
 * Append whole-document proposals as a labeled "Alternative version"
 * section at the end of the body. The appendix's content is a
 * block-level diff between the original document and the proposed
 * one: unchanged blocks render as plain text, removed blocks in
 * `<w:del>`, added blocks in `<w:ins>`. Reviewers can scan
 * change-by-change instead of being shown the entire alternative
 * as wall-to-wall insertion.
 *
 * Replacement pairs (a removed block followed immediately by an
 * added block) get inline word-level diff via `tryEmitInlineWordDiff`
 * when both sides are single plain-prose paragraphs — same path the
 * block-level proposal handler uses. Otherwise the pair degrades to
 * sequential delete + insert blocks.
 *
 * If the diff churn dominates the document (most blocks changed),
 * the appendix falls back to the original wall-to-wall insertion —
 * a near-total rewrite is more readable as one alternative version
 * than as a sea of revision marks against a phantom original.
 */
function appendWholeDocProposals(
  body: readonly FileChild[],
  originalHast: HastRoot,
  ctx: BuildCtx,
): FileChild[] {
  const review = ctx.review;
  if (!review || review.wholeDoc.length === 0) return [...body];
  const out: FileChild[] = [...body];
  for (const thread of review.wholeDoc) {
    const opener = thread.comments[0];
    const author = opener.author || 'Markdowner reviewer';
    const date = new Date(opener.date).toISOString();
    out.push(
      mkParagraph(
        {
          style: 'Heading2',
          heading: HeadingLevel.HEADING_2,
          children: [
            new TextRun({
              text: `Alternative version proposed by ${author} (${formatDate(opener.date)})`,
            }),
          ],
        },
        ctx,
      ),
    );
    const propHast = review.proposalHasts.get(thread.id);
    if (!propHast) continue;
    const commentIds = allocCommentIdsForThread(thread, ctx);
    const diffBlocks = renderWholeDocBlockDiff(
      originalHast,
      propHast,
      author,
      date,
      ctx,
    );
    out.push(...wrapBufferWithCommentRanges(diffBlocks, commentIds, ctx));
  }
  return out;
}

/**
 * Block-level diff between the original document HAST and a
 * proposal's pre-parsed `proposed_text` HAST. Returns FileChildren
 * suitable for the appendix:
 *
 *   - unchanged top-level blocks render as plain text (no revision
 *     wrapping at all — they really are unchanged content);
 *   - blocks present only in the original render in DELETE mode;
 *   - blocks present only in the proposal render in INSERT mode;
 *   - adjacent removed+added pairs route through
 *     `tryEmitInlineWordDiff` for word-level inline diff when both
 *     sides are single plain-prose paragraphs.
 *
 * The diff itself is `diffArrays` over a normalized plain-text key
 * per block — the same kind of key `remarkBlockIds` uses to compute
 * its content hash. That gives stable matching for unchanged blocks
 * even when surrounding structure shifts (a paragraph re-numbered
 * in a list, etc.).
 *
 * Falls back to the original "wall-to-wall insertion" path when
 * the change ratio dominates: a near-total rewrite reads better as
 * one alternative version than as a sea of revision marks against
 * a near-empty unchanged scaffold.
 */
function renderWholeDocBlockDiff(
  originalHast: HastRoot,
  proposedHast: HastRoot,
  author: string,
  date: string,
  ctx: BuildCtx,
): FileChild[] {
  const originalBlocks = topLevelBlocks(originalHast);
  const proposedBlocks = topLevelBlocks(proposedHast);
  const originalKeys = originalBlocks.map(blockDiffKey);
  const proposedKeys = proposedBlocks.map(blockDiffKey);

  const changes = diffArrays(originalKeys, proposedKeys);

  // Churn ratio: how many blocks are changed (added OR removed)
  // relative to the larger side. Above this we fall back to the
  // pre-diff wall-of-insertion path so a complete rewrite isn't
  // rendered as a sea of revision marks.
  const totalChanged = changes
    .filter((c) => c.added || c.removed)
    .reduce((n, c) => n + c.value.length, 0);
  const denom = Math.max(originalKeys.length, proposedKeys.length, 1);
  if (totalChanged / denom > 0.7) {
    return renderWholeDocAsInsertion(proposedHast, author, date, ctx);
  }

  const review = ctx.review!;
  const ctxEqual: BuildCtx = { ...ctx, review: null };
  const defaultWalk: WalkCtx = { listDepth: 0, blockquoteDepth: 0 };

  // Each removed/added block is its OWN logical change in Word's
  // accept/reject UX (a reviewer can keep one paragraph's deletion
  // and reject another's insertion independently). Build a fresh
  // BuildCtx with a freshly-allocated revision id per block.
  const delCtx = (): BuildCtx => ({
    ...ctx,
    revision: {
      kind: 'delete',
      author,
      date,
      id: review.nextRevisionId.value++,
    },
  });
  const insCtx = (): BuildCtx => ({
    ...ctx,
    revision: {
      kind: 'insert',
      author,
      date,
      id: review.nextRevisionId.value++,
    },
    // Disable review interception during the sub-walk so a block-id
    // collision between the appendix and the live document can't
    // recurse through emitProposalBlock.
    review: null,
  });

  const out: FileChild[] = [];
  let origIdx = 0;
  let propIdx = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    const next = changes[i + 1];
    if (!change.added && !change.removed) {
      for (let k = 0; k < change.value.length; k++) {
        convertBlockInner(
          originalBlocks[origIdx]!,
          ctxEqual,
          out,
          defaultWalk,
        );
        origIdx++;
      }
      propIdx += change.value.length;
      continue;
    }

    // Replacement: a `removed` immediately followed by an `added`.
    // Try inline word-diff per matching pair before falling back to
    // sequential delete + insert.
    if (change.removed && next?.added) {
      const removedSlice = originalBlocks.slice(origIdx, origIdx + change.value.length);
      const addedSlice = proposedBlocks.slice(propIdx, propIdx + next.value.length);
      const pairCount = Math.min(removedSlice.length, addedSlice.length);
      for (let k = 0; k < pairCount; k++) {
        const inline = tryEmitInlineWordDiffForPair(
          removedSlice[k]!,
          addedSlice[k]!,
          author,
          date,
          ctx,
          defaultWalk,
        );
        if (inline) {
          out.push(
            mkParagraph(
              withParagraphContext({ children: inline }, ctx, defaultWalk),
              ctx,
            ),
          );
        } else {
          convertBlockInner(removedSlice[k]!, delCtx(), out, defaultWalk);
          convertBlockInner(addedSlice[k]!, insCtx(), out, defaultWalk);
        }
      }
      // Tail: leftover removed blocks (when removedSlice is longer).
      for (let k = pairCount; k < removedSlice.length; k++) {
        convertBlockInner(removedSlice[k]!, delCtx(), out, defaultWalk);
      }
      // Tail: leftover added blocks (when addedSlice is longer).
      for (let k = pairCount; k < addedSlice.length; k++) {
        convertBlockInner(addedSlice[k]!, insCtx(), out, defaultWalk);
      }
      origIdx += change.value.length;
      propIdx += next.value.length;
      i++; // also consumed `next`.
      continue;
    }

    if (change.removed) {
      for (let k = 0; k < change.value.length; k++) {
        convertBlockInner(originalBlocks[origIdx]!, delCtx(), out, defaultWalk);
        origIdx++;
      }
      continue;
    }
    // change.added without a preceding `removed`.
    for (let k = 0; k < change.value.length; k++) {
      convertBlockInner(proposedBlocks[propIdx]!, insCtx(), out, defaultWalk);
      propIdx++;
    }
  }
  return out;
}

/**
 * Inline word-diff variant that takes two HAST elements (the
 * "before" and "after" blocks) instead of a ReviewThread. Same
 * qualification rules as `tryEmitInlineWordDiff` — returns null
 * when the pair is too structural to flatten safely.
 */
function tryEmitInlineWordDiffForPair(
  before: HastNode,
  after: HastNode,
  author: string,
  date: string,
  ctx: BuildCtx,
  _walk: WalkCtx,
): ParagraphChild[] | null {
  if (!isElement(before) || !isElement(after)) return null;
  if (before.tagName !== 'p' || after.tagName !== 'p') return null;
  const oldText = pureTextContent(before);
  const newText = pureTextContent(after);
  if (oldText === null || newText === null) return null;
  if (oldText === newText) return null;
  // Reuse the shared helper so both block-level and whole-doc
  // word-diff paths share the "one revision id per logical change"
  // invariant.
  return runsForInlineWordDiff(oldText, newText, author, date, ctx);
}

/**
 * Whole-document proposal fallback: render the entire proposed
 * body in INSERT mode with no diff alignment. Used when the change
 * ratio is so high that a block-level diff would be more noise
 * than signal — a complete rewrite is clearer as one alternative
 * version than as a series of delete-block / insert-block pairs.
 */
function renderWholeDocAsInsertion(
  proposedHast: HastRoot,
  author: string,
  date: string,
  ctx: BuildCtx,
): FileChild[] {
  const review = ctx.review!;
  // Wall-of-insertion is one logical change ("insert this entire
  // alternative version"), so the whole pass shares a single
  // revision id — accepting it should accept the whole alternative.
  const ctxIns: BuildCtx = {
    ...ctx,
    revision: {
      kind: 'insert',
      author,
      date,
      id: review.nextRevisionId.value++,
    },
    review: null,
  };
  return hastToDocxChildren(proposedHast, ctxIns, {});
}

/** Top-level meaningful blocks of a HAST root, skipping whitespace text. */
function topLevelBlocks(root: HastRoot): readonly Element[] {
  const out: Element[] = [];
  for (const node of flattenRoot(root)) {
    if (isText(node) && node.value.trim() === '') continue;
    if (isElement(node)) out.push(node);
  }
  return out;
}

/**
 * Diff key for a top-level block. Compares the block's tag-name and
 * its normalized plain-text content — collapses whitespace so two
 * blocks that only differ in spacing match, but distinguishes a
 * `<p>` from an `<h2>` even when the text is identical.
 *
 * The tag-name and text are joined by the explicit Unicode Unit
 * Separator (`U+001F`). Sanitize strips control characters from
 * HAST text before this point, so the separator can't appear in
 * the payload — the key stays unambiguous even if a block's text
 * happens to start with another tag's name (e.g. a `<p>` whose
 * text begins with "h2 ").
 */
const BLOCK_DIFF_KEY_SEP = '\u001F';
function blockDiffKey(node: Element): string {
  const text = hastTextContent(node).replace(/\s+/gu, ' ').trim();
  return `${node.tagName}${BLOCK_DIFF_KEY_SEP}${text}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

// Silence a type-only export if docx's Paragraph constructor parameter is
// referenced; keeps this module's surface stable for tests.
export type { Document as _DocxDocument };
// Re-export UnderlineType for future link-underline styling work.
export { UnderlineType };
