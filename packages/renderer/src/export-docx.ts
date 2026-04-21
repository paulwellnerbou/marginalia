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
 * - M5: BCP-47 language tag + `<w:bidi/>` for RTL frontmatter.
 *
 * Out of scope (future milestones): real Mermaid rasterization (blocks
 * currently fall back to a labeled code block until a headless-browser
 * backend is wired up).
 */

import rehypeParse from 'rehype-parse';
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
  const images = await resolveAllImages(hast, options.resolveAsset);

  // Pull GFM footnotes out of the body: build their DOCX paragraphs,
  // assign each a numeric id, and remove the `<section>` so it won't
  // appear inline. The walker later turns `<sup>` refs into
  // `FootnoteReferenceRun`s pointed at those ids.
  const ctxWithoutFootnotes: BuildCtx = {
    tokens,
    images,
    pageWidthPx: contentWidthPx(tokens),
    footnoteIds: new Map(),
  };
  const footnotes = extractFootnotes(hast, ctxWithoutFootnotes);
  const ctx: BuildCtx = { ...ctxWithoutFootnotes, footnoteIds: footnotes.ids };

  const body = hastToDocxChildren(hast, ctx);

  // Prepend TOC if requested. `auto` (and undefined) emit a TOC only
  // when the doc has ≥ 2 headings, so single-heading notes don't get
  // a pointless "Contents" section above their lone title.
  const shouldIncludeToc =
    options.includeToc === true ||
    ((options.includeToc === 'auto' || options.includeToc === undefined) &&
      countHeadings(hast) >= 2);
  const blocks: FileChild[] = shouldIncludeToc
    ? [...buildTocBlocks(options.tocLabel ?? 'Contents', tokens), ...body]
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
function buildTocBlocks(label: string, tokens: ThemeTokens): FileChild[] {
  const out: FileChild[] = [];
  if (label) {
    out.push(
      new Paragraph({
        style: 'Heading1',
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: label, color: hex(tokens.colors.fg) })],
      }),
    );
  }
  // `hyperlink: true` makes entries clickable in Word.
  // `headingStyleRange: '1-6'` pulls all heading levels into the TOC.
  // `beginDirty: true` marks the TOC field dirty so Word prompts to
  // auto-populate on first open (otherwise the user sees an empty
  // placeholder until they press F9).
  out.push(
    new TableOfContents(label || 'Table of Contents', {
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
    renderCell: async () => '', // DOCX path doesn't need per-cell HTML
  });

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkExtractFrontmatter)
    .use(remarkSlugger)
    .use(remarkBlockIds)
    .use(remarkMermaid, { mode: 'client' })
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

/** Strip leading '#' and validate — defensive; we control token hex strings. */
const hex = (c: string): string => c.replace(/^#/, '').toLowerCase();

/**
 * Usable content width (in CSS px at 96 DPI) for the current page. We
 * use this to scale images down so they don't blow past the margins.
 * docx's `ImageRun` transformation is in pixels.
 */
function contentWidthPx(tokens: ThemeTokens): number {
  // A4 ≈ 595pt, Letter ≈ 612pt, A5 ≈ 420pt, B5 ≈ 499pt.
  const pageWidthPt = ({ A4: 595, Letter: 612, A5: 420, B5: 499 } as const)[tokens.page.size];
  const contentPt = pageWidthPt - 2 * tokens.page.marginPt;
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
        const img = probeImage(asset.bytes, asset.mime);
        return [src, img];
      } catch {
        // Swallow: a broken image should never break the whole export.
        return [src, null];
      }
    }),
  );
  return new Map(entries);
}

function decodeDataUrl(url: string): ResolvedAsset | null {
  // data:[<mime>][;base64],<data>
  const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const isBase64 = m[2] === ';base64';
  const payload = m[3] ?? '';
  try {
    const bytes = isBase64
      ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return { bytes, mime };
  } catch {
    return null;
  }
}

function probeImage(bytes: Uint8Array, mime: string): ResolvedImage | null {
  const type = mimeToDocxType(mime);
  if (!type) return null; // SVG and others unsupported for now (see M4b).
  try {
    const info = imageSize(bytes);
    if (!info.width || !info.height) return null;
    return { bytes, mime, width: info.width, height: info.height, type };
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

  // Second pass: build the Paragraph content, now that every slug has
  // an id (so a footnote that itself refs another still works).
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
      content[String(id)] = { children: buildFootnoteParagraphs(li, ctx) };
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
    if (!isElement(child)) continue;
    // Inline text directly inside the <li> (rare but possible) just
    // becomes a paragraph of that text.
    appendFootnoteBlock(child, ctx, out);
  }
  if (out.length === 0) {
    // Always emit at least one paragraph so the footnote renders —
    // blank footnotes would confuse readers more than an empty line.
    out.push(new Paragraph({ children: [] }));
  }
  return out;
}

function appendFootnoteBlock(node: Element, ctx: BuildCtx, out: Paragraph[]): void {
  switch (node.tagName) {
    case 'p': {
      const inline = collectInline(node, ctx, {});
      if (inline.length > 0) out.push(new Paragraph({ children: inline }));
      return;
    }
    case 'pre':
      // Reuses the CodeBlock style built for the body; still valid
      // inside footnote paragraphs.
      out.push(...buildCodeBlock(node, ctx.tokens));
      return;
    case 'blockquote':
      for (const c of node.children as HastNode[]) {
        if (!isElement(c)) continue;
        const inline = collectInline(c, ctx, {});
        if (inline.length > 0) {
          out.push(new Paragraph({ style: 'Blockquote', children: inline }));
        }
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
          new Paragraph({
            children: [new TextRun({ text: prefix }), ...children],
          }),
        );
      }
      return;
    }
    case 'section':
    case 'div':
    case 'figure':
    case 'article':
      for (const c of node.children as HastNode[]) {
        if (isElement(c)) appendFootnoteBlock(c, ctx, out);
      }
      return;
    default: {
      // Last-resort: flatten to plain text so nothing the user wrote
      // disappears silently. `hastTextContent` strips tags; the
      // trailing backref `↩` is still inside the tree here but
      // walkInline-free paths need their own filter. We keep it: the
      // arrow is a literal Unicode char, harmless if it slips through.
      const text = hastTextContent(node).trim();
      if (text) out.push(new Paragraph({ children: [new TextRun({ text })] }));
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
  const section: ISectionOptions = {
    properties: {
      page: {
        size: pageSize(tokens),
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

function pageSize(tokens: ThemeTokens): { width: number; height: number } {
  // DOCX uses twips; sizes below cover the theme token enum values.
  // 1 mm = ~56.69 twips; use convertMillimetersToTwip for accuracy.
  const mm = (w: number, h: number) => ({
    width: convertMillimetersToTwip(w),
    height: convertMillimetersToTwip(h),
  });
  switch (tokens.page.size) {
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
            line: Math.round(tokens.lineHeight.body * 240),
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
          indent: { left: pt2twip(18) },
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
  readonly pageWidthPx: number;
  /**
   * GFM footnote slug → numeric DOCX footnote id (1-based). Populated
   * by `extractFootnotes` before walking; read when the inline walker
   * hits a `<sup><a data-footnote-ref>` reference.
   */
  readonly footnoteIds: Map<string, number>;
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

function hastToDocxChildren(root: HastRoot, ctx: BuildCtx): FileChild[] {
  const out: FileChild[] = [];
  const topLevel = flattenRoot(root);
  for (const node of topLevel) {
    convertBlock(node, ctx, out, { listDepth: 0 });
  }
  return out;
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
      out.push(new Paragraph({ children: [new TextRun({ text: node.value })] }));
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
        new Paragraph({
          children: collectInline(node, ctx, {}),
        }),
      );
      return;

    case 'blockquote':
      for (const child of node.children) {
        if (!isElement(child)) continue;
        out.push(
          new Paragraph({
            style: 'Blockquote',
            children: collectInline(child, ctx, {}),
          }),
        );
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
      for (const child of node.children) convertBlock(child as HastNode, ctx, out, walk);
      return;

    case 'div': {
      // `<div class="mermaid">` carries the diagram source. Real
      // rasterization (SVG → PNG → ImageRun) is M4b territory and
      // depends on headless Chromium — until that lands, render the
      // source as a labeled code block so readers at least get a
      // legible record of the diagram instead of a stray inline run.
      const cls = node.properties?.className;
      const isMermaid =
        Array.isArray(cls) && (cls as unknown[]).includes('mermaid');
      if (isMermaid) {
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
      for (const child of node.children) convertBlock(child as HastNode, ctx, out, walk);
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
        if (inline.length > 0) out.push(new Paragraph({ children: inline }));
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
  const alt = String(node.properties?.alt ?? node.properties?.src ?? '');
  return new Paragraph({
    children: [
      new TextRun({
        text: `[image: ${alt}]`,
        italics: true,
        color: hex(ctx.tokens.colors.fgMuted),
      }),
    ],
  });
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

  for (const item of node.children) {
    if (!isElement(item) || item.tagName !== 'li') continue;
    // The li's first paragraph (or loose inline content) becomes the
    // list item's paragraph; nested lists follow.
    const inlineChildren: HastNode[] = [];
    const blockChildren: HastNode[] = [];
    for (const c of item.children) {
      if (isElement(c) && (c.tagName === 'ul' || c.tagName === 'ol')) {
        blockChildren.push(c);
      } else if (isElement(c) && c.tagName === 'p') {
        // tight list items wrap a <p> — unwrap so all inline content
        // lands in one list paragraph.
        inlineChildren.push(...(c.children as HastNode[]));
      } else {
        inlineChildren.push(c);
      }
    }

    out.push(
      new Paragraph({
        numbering: { reference, level },
        children: collectInlineFromMany(inlineChildren, ctx, {}),
      }),
    );

    for (const nested of blockChildren) {
      convertBlock(nested, ctx, out, {
        listDepth: walk.listDepth + 1,
        inOrderedList: ordered,
      });
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
        lines[lines.length - 1]!.push(new TextRun(runOptions({ ...style, code: true }, part, tokens)));
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
      const linkChildren: ParagraphChild[] = [];
      walkChildren(n, ctx, { ...style, color: tokens.colors.accent }, linkChildren);

      if (href.startsWith('#') && href.length > 1) {
        // Internal anchor link — points at a heading bookmark in this
        // same document. Word renders these as clickable navigation
        // inside the doc.
        out.push(
          new InternalHyperlink({
            anchor: href.slice(1),
            children: linkChildren.length > 0
              ? linkChildren
              : [
                  new TextRun(
                    runOptions({ ...style, color: tokens.colors.accent }, href, tokens),
                  ),
                ],
          }),
        );
        return;
      }

      out.push(
        new ExternalHyperlink({
          link: href,
          children: linkChildren.length > 0
            ? linkChildren
            : [
                new TextRun(
                  runOptions({ ...style, color: tokens.colors.accent }, href, tokens),
                ),
              ],
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
      const alt = String(n.properties?.alt ?? n.properties?.src ?? '');
      out.push(
        new TextRun(
          runOptions(
            { ...style, italic: true, color: tokens.colors.fgMuted },
            `[image: ${alt}]`,
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
  if (style.code) {
    // Inline code runs size down slightly, matching the CSS rule
    // `.marginalia :not(pre) > code { font-size: 0.9em }`.
    opts.size = pt2hp(tokens.fontSize.basePt * 0.9);
    opts.font = style.font ?? tokens.fonts.mono.families[0] ?? 'monospace';
  }
  if (text && opts.size === undefined) opts.size = pt2hp(tokens.fontSize.basePt);
  return opts as IRunOptions;
}

// Silence a type-only export if docx's Paragraph constructor parameter is
// referenced; keeps this module's surface stable for tests.
export type { Document as _DocxDocument };
// Re-export UnderlineType for future link-underline styling work.
export { UnderlineType };
