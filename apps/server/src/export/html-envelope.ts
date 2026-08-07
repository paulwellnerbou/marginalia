/**
 * Self-contained HTML document assembly for the PDF exporter.
 *
 * Takes the renderer's body HTML, the resolved theme CSS, the shared
 * print stylesheet, and per-document metadata, and produces an HTML
 * string suitable for `page.setContent()`. Mermaid's UMD is inlined
 * when present (no external script src).
 *
 * What this module does NOT do: rewrite absolute / remote URLs that
 * remain in `body`. `inlineImageAssets()` handles document-local
 * blob refs only — any `<img src="https://…">` the author wrote is
 * left alone here. The outbound-request firewall in `pdf.ts`
 * (`page.route('**\/*', …)`) is what prevents those from reaching
 * the network at render time.
 *
 * Google Fonts `@import url(...)` lines in the theme CSS are also
 * left alone and ARE allowed through the firewall — Chromium
 * fetches them and `document.fonts.ready` gates the print.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { BlobStore } from '../blob-store.js';

export interface EnvelopeMeta {
  /** Document title — goes into `<title>` and `<meta name>` tags. */
  title: string | null;
  /** Document author (exporter's display name). */
  author: string | null;
  /** Appearance override. Export is always light — themes may still
   * emit dark-mode variables and `_print.css` normalises them. */
  appearance?: 'light';
}

export interface EnvelopeOptions {
  /** Rendered (and sanitized) document body HTML. */
  body: string;
  /** Resolved theme CSS (with local @imports already inlined). */
  themeCss: string;
  /** Shared print stylesheet. */
  printCss: string;
  /** Document metadata for `<head>`. */
  meta: EnvelopeMeta;
  /**
   * True iff the renderer reported at least one mermaid block. When
   * true, the envelope inlines the mermaid runtime and a bootstrapper
   * that resolves `window.__marginaliaMermaidReady` after
   * `mermaid.run()`.
   *
   * When false, the envelope skips ~3 MB of inline JS — most documents
   * have no mermaid blocks so this is the dominant case.
   */
  hasMermaid: boolean;
}

/**
 * Build the final HTML string fed to `page.setContent()`.
 *
 * Pure function of its inputs — no I/O, no global state. The mermaid
 * UMD bundle is injected via `loadMermaidUmd()` if needed; call sites
 * that don't need mermaid skip that read entirely.
 */
export function buildExportHtml(opts: EnvelopeOptions & { mermaidUmd?: string }): string {
  const { body, themeCss, printCss, meta, hasMermaid, mermaidUmd } = opts;
  const appearance = meta.appearance ?? 'light';
  const safeTitle = escapeHtml(meta.title ?? 'Document');
  const safeAuthor = meta.author ? escapeHtml(meta.author) : null;

  return `<!doctype html>
<html lang="en" data-appearance="${appearance}">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
${safeAuthor ? `<meta name="author" content="${safeAuthor}">\n` : ''}<meta name="generator" content="Marginalia PDF export">
<style id="marginalia-theme-css">
${themeCss}
</style>
<style id="marginalia-print-css">
${printCss}
</style>
</head>
<body class="marginalia-theme">
<article class="marginalia">
${body}
</article>
${hasMermaid && mermaidUmd ? mermaidBootstrap(mermaidUmd) : ''}
</body>
</html>`;
}

/**
 * Inline the mermaid runtime and start it against the rendered
 * document, resolving `window.__marginaliaMermaidReady` when done (or
 * failed — we don't want the exporter to hang on a single bad
 * diagram). The exporter awaits this sentinel before calling
 * `page.pdf()`.
 */
function mermaidBootstrap(umd: string): string {
  // The UMD sets `globalThis.mermaid`. We initialise it with
  // `startOnLoad: false` (matches the viewer at
  // apps/web/src/lib/mermaid.ts:24), then run over every block.
  // `querySelector` form of `mermaid.run()` is synchronous to enumerate
  // so there's no mid-flight detachment like the viewer worries about.
  return `<script>${umd}</script>
<script>
(async () => {
  try {
    if (!window.mermaid) {
      console.error('[marginalia-pdf] mermaid runtime not present');
      return;
    }
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'default',
      fontFamily: 'inherit',
      themeVariables: { fontSize: '18px' },
      flowchart: { htmlLabels: true },
    });
    await window.mermaid.run({ querySelector: 'div.mermaid, pre.mermaid' });
  } catch (err) {
    // Swallow — one bad diagram shouldn't block the entire export.
    // The print stylesheet falls back to rendering the raw source in a
    // dashed frame (see packages/themes/css/_print.css).
    console.error('[marginalia-pdf] mermaid run failed', err);
  } finally {
    window.__marginaliaMermaidReady = true;
  }
})();
</script>`;
}

/**
 * Pre-rasterize mermaid blocks in a rendered HTML body, replacing
 * `<div class="mermaid">…source…</div>` with the resolver's output
 * (typically inline `<svg>` for the mmdr path).
 *
 * Why pre-rasterize for PDF: the body lands inside a Chromium page.
 * If we leave `<div class="mermaid">` divs in, the export envelope
 * has to inline the ~3 MB mermaid UMD and wait on the in-page
 * runtime — that's the existing `chromium` renderer path. When the
 * caller picked `mmdr` (per-document setting), we can render every
 * diagram out-of-process first, splice SVG into the body, and let
 * the PDF stage skip the mermaid runtime entirely (faster, smaller
 * bytes through `setContent`).
 *
 * The resolver is called with the un-escaped mermaid source (HTML
 * entities decoded back to `<`, `>`, `&`). Returning `null` leaves
 * that block untouched — useful as a per-block escape hatch and
 * also as the natural behaviour when the renderer fails on one
 * diagram of many. Untouched blocks fall through to the in-page
 * runtime, exactly as today.
 *
 * Input HTML is the renderer's own output (sanitized, predictable
 * shape — double-quoted attributes, no embedded `"` in attribute
 * values, no `<` inside the diagram source because remarkMermaid
 * escapes it). The regex is therefore safe enough.
 */
export interface PrerasterizedMermaidBlock {
  /** Image bytes from the resolver. */
  readonly bytes: Uint8Array;
  /** `image/svg+xml` or `image/png`. */
  readonly mime: 'image/svg+xml' | 'image/png';
}

export type MermaidPrerasterResolver = (
  source: string,
  index: number,
) => Promise<PrerasterizedMermaidBlock | null>;

export interface PrerasterizeMermaidOptions {
  /**
   * Maximum concurrent `resolve()` calls in flight. The PDF mmdr
   * path spawns a subprocess per diagram and the chromium path
   * opens a BrowserContext per diagram — neither is free. Default
   * 4 is the same ceiling `exportDocx` uses (see
   * `DocxExportOptions.mermaidConcurrency`).
   */
  concurrency?: number;
}

/** Default ceiling — kept in sync with `export-docx.ts`'s default. */
const DEFAULT_PRERASTER_CONCURRENCY = 4;

export async function prerasterizeMermaid(
  html: string,
  resolve: MermaidPrerasterResolver,
  options: PrerasterizeMermaidOptions = {},
): Promise<string> {
  // Match the entire mermaid div including its inner content.
  // `[\s\S]*?` lets the inner source span newlines without needing
  // the `s` flag. The capture groups are: (1) the data-mermaid-index
  // value, (2) the inner (escaped) source text.
  const re =
    /<div\b[^>]*\bclass="mermaid"[^>]*\bdata-mermaid-index="(\d+)"[^>]*>([\s\S]*?)<\/div>/g;
  interface Hit {
    start: number;
    end: number;
    index: number;
    source: string;
  }
  const hits: Hit[] = [];
  let m = re.exec(html);
  while (m !== null) {
    const index = Number.parseInt(m[1] ?? '', 10);
    if (Number.isInteger(index) && index >= 0) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        index,
        source: decodeHtmlEntities(m[2] ?? ''),
      });
    }
    m = re.exec(html);
  }
  if (hits.length === 0) return html;

  // Resolve with bounded parallelism. Without the cap, a 20-diagram
  // doc would fan out into 20 simultaneous renderer subprocesses /
  // BrowserContexts and starve the host — same failure mode the
  // DOCX path already mitigates via `DocxExportOptions
  // .mermaidConcurrency`. Failure of an individual diagram surfaces
  // as `null`; we leave that block untouched so it falls back to
  // the in-page mermaid runtime.
  const limit = Math.max(
    1,
    typeof options.concurrency === 'number' && Number.isFinite(options.concurrency)
      ? Math.floor(options.concurrency)
      : DEFAULT_PRERASTER_CONCURRENCY,
  );
  const resolved = await mapWithConcurrency(hits, limit, async (h) => {
    try {
      return await resolve(h.source, h.index);
    } catch {
      return null;
    }
  });

  let out = '';
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i] as Hit;
    const r = resolved[i];
    if (!r) continue; // leave the original div in place
    out += html.slice(cursor, h.start);
    out += renderImageMarkup(r);
    cursor = h.end;
  }
  out += html.slice(cursor);
  return out;
}

/**
 * Worker-pool helper — same shape as `export-docx.ts`'s
 * `mapWithConcurrency`, kept private to this module so the server
 * package doesn't depend on the renderer for a 10-line utility.
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

/**
 * Count mermaid blocks in `html` that still need the in-page mermaid
 * runtime to render — i.e. blocks the prerasterizer didn't touch.
 *
 * Naively counting `<div class="mermaid">` would over-report:
 * `prerasterizeMermaid` emits `<div class="mermaid mermaid-
 * prerendered">…inline svg…</div>` (the `mermaid` class survives so
 * the print stylesheet still targets the diagram). The right marker
 * for "live" blocks is the renderer's own `data-mermaid-index` /
 * `data-mermaid-mode` attribute — only the unprocessed divs carry
 * those, since the prerendered wrapper drops them.
 *
 * Used by the PDF route to decide whether the export envelope needs
 * to inline the ~3 MB mermaid UMD: zero live blocks → skip the UMD
 * entirely (fast path); ≥ 1 → keep the UMD so leftover blocks fall
 * back to client-side rendering.
 */
export function countLiveMermaidBlocks(html: string): number {
  // Match `<div class="…mermaid…">` with a `data-mermaid-(index|mode)=`
  // attribute somewhere in the tag. The lookahead doesn't anchor
  // attribute order — both upstream plugins emit different orderings
  // and we shouldn't depend on either.
  const re =
    /<div\b[^>]*\bclass="[^"]*\bmermaid\b[^"]*"(?=[^>]*\bdata-mermaid-(?:index|mode)=)[^>]*>/g;
  return (html.match(re) ?? []).length;
}

/**
 * Rewrite mermaid blocks the pre-rasterizer left behind as a plain
 * code listing. Targets are the same `data-mermaid-(index|mode)`
 * divs `countLiveMermaidBlocks` counts — blocks that still expect a
 * mermaid runtime to replace them.
 *
 * Only for exports that have no runtime to fall back on (EPUB): the
 * PDF page loads the mermaid UMD and renders these for real, so it
 * must not call this. Without it a failed diagram reaches the reader
 * as its own source text set as prose.
 */
export function demoteLiveMermaidBlocks(html: string): string {
  return html.replace(
    /<div\b[^>]*\bclass="[^"]*\bmermaid\b[^"]*"(?=[^>]*\bdata-mermaid-(?:index|mode)=)[^>]*>([\s\S]*?)<\/div>/g,
    (_match, source: string) => `<pre class="mermaid-source"><code>${source}</code></pre>`,
  );
}

function renderImageMarkup(r: PrerasterizedMermaidBlock): string {
  if (r.mime === 'image/svg+xml') {
    // Decode only on this branch — the PNG path doesn't need the
    // text form and TextDecoder over a multi-MB raster on a doc
    // with many diagrams isn't free.
    const decoded = new TextDecoder().decode(r.bytes);
    // Strip a leading XML prolog if present — inline SVG inside HTML
    // doesn't want one. Keep everything from the `<svg ...>` tag on.
    const svgStart = decoded.indexOf('<svg');
    const svgBody = svgStart >= 0 ? decoded.slice(svgStart) : decoded;
    return `<div class="mermaid mermaid-prerendered">${svgBody}</div>`;
  }
  // PNG path — embed as a data URL inside an `<img>` tag wrapped in
  // the same .mermaid container so existing print CSS still targets
  // it.
  const b64 = Buffer.from(r.bytes).toString('base64');
  return `<div class="mermaid mermaid-prerendered"><img src="data:image/png;base64,${b64}" alt="Mermaid diagram"></div>`;
}

/**
 * Decode the small set of HTML entities that `remarkMermaid` /
 * `rehypeAsciidocMermaid` emit when stuffing mermaid source into
 * div text content (`&` → `&amp;`, `<` → `&lt;`). The full HTML
 * entity set is unnecessary — the upstream plugins only escape the
 * canonical four.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // last so we don't double-decode `&amp;lt;`
}

/**
 * Inline `<img src="REF">` tags whose `src` is a document-local ref
 * name with the corresponding blob's bytes as a `data:` URL. Mirrors
 * the DOCX exporter's `resolveAsset` flow — same bytes, different
 * packaging.
 *
 * Input HTML comes from `renderDocument()` which runs through
 * `rehype-sanitize`, so the shape of `<img …>` tags is predictable
 * (double-quoted attributes, no embedded `"` characters in `src`).
 * The regex is therefore safe enough — we're not trying to parse
 * arbitrary HTML, just `<img>` tags in our own output.
 */
export async function inlineImageAssets(
  html: string,
  attached: Map<string, { assetId: string; mime: string }>,
  blobs: BlobStore,
): Promise<string> {
  if (attached.size === 0) return html;

  // Collect all `<img src="…">` matches whose src is a known ref, then
  // resolve bytes in parallel, then splice. Two-pass keeps async work
  // out of the regex loop.
  interface Hit {
    start: number;
    end: number;
    ref: string;
    mime: string;
    assetId: string;
  }
  // The `d` flag exposes `match.indices[n] = [start, end]` for each
  // capture group. We use it to get the EXACT span of the `src`
  // attribute value in the source HTML — an earlier
  // `m[0].indexOf(src)` implementation was wrong for `<img>` tags
  // where the same substring happens to appear earlier in the tag
  // (e.g. `alt="logo.png image"` with `src="logo.png"` would target
  // the alt text).
  const hits: Hit[] = [];
  const imgRe = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/dg;
  let m = imgRe.exec(html);
  while (m !== null) {
    const src = m[1]!;
    const hit = attached.get(src);
    const srcIndices = m.indices?.[1];
    if (!isAbsoluteUrl(src) && hit && srcIndices) {
      hits.push({
        start: srcIndices[0],
        end: srcIndices[1],
        ref: src,
        mime: hit.mime,
        assetId: hit.assetId,
      });
    }
    m = imgRe.exec(html);
  }
  if (hits.length === 0) return html;

  // Dedupe by assetId so a doc with the same image in 50 places only
  // reads the blob once.
  const uniqueIds = Array.from(new Set(hits.map((h) => h.assetId)));
  const bytesById = new Map<string, Uint8Array>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        bytesById.set(id, await blobs.get(id));
      } catch {
        // Missing blob — leave the original src untouched so the
        // print stylesheet or viewer semantics decide what to do.
        // (Rare outside of a GC bug.)
      }
    }),
  );

  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    const bytes = bytesById.get(hit.assetId);
    if (!bytes) continue;
    out += html.slice(cursor, hit.start);
    out += toDataUrl(bytes, hit.mime);
    cursor = hit.end;
  }
  out += html.slice(cursor);
  return out;
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  // `Buffer.from(Uint8Array).toString('base64')` is the fastest path
  // in Bun for blob sizes we actually handle (up to a few MB).
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${escapeMime(mime)};base64,${b64}`;
}

function escapeMime(mime: string): string {
  // Defensive: the attached.mime comes from the DB, but make sure a
  // rogue value can't escape the data-URL grammar.
  return mime.replace(/[^a-zA-Z0-9/+.-]/g, '');
}

function isAbsoluteUrl(src: string): boolean {
  if (src.startsWith('#')) return true;
  if (src.startsWith('/')) return true;
  if (src.startsWith('data:')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return true;
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read and cache the mermaid IIFE bundle. The bundle ships ~3 MB of
 * text; we read it lazily on the first `loadMermaidUmd()` call and
 * cache the resulting promise to avoid a disk hit on every
 * mermaid-bearing export.
 *
 * Resolution order:
 *   1. `MARGINALIA_MERMAID_JS_PATH` env var — points at a fully
 *      resolved file path. Set in the Docker runtime (see Dockerfile
 *      `vendor/mermaid.min.js`) where the mermaid package itself is
 *      not installed to keep the image lean.
 *   2. `apps/server/vendor/mermaid.min.js` relative to this module —
 *      the default vendored location. Works in any deployment where
 *      the vendor file was copied in during image build.
 *   3. `import.meta.resolve('mermaid/dist/mermaid.min.js')` —
 *      node_modules lookup. Used for local dev (`bun run dev`) where
 *      mermaid is installed as a regular workspace dep.
 *
 * `mermaid/dist/mermaid.min.js` is the IIFE build that assigns
 * `globalThis.mermaid = …` at the end. Perfect for `<script>…</script>`
 * injection into the export page.
 */
let mermaidUmdCache: Promise<string> | null = null;
export function loadMermaidUmd(): Promise<string> {
  if (!mermaidUmdCache) {
    mermaidUmdCache = (async () => {
      // 1. Explicit env override.
      const envPath = process.env.MARGINALIA_MERMAID_JS_PATH;
      if (envPath) return readFile(envPath, 'utf8');

      // 2. Vendored location inside the server package. Try it
      // first so production images (where mermaid is not installed
      // as a dep) work without an env var.
      const vendoredUrl = new URL('../../vendor/mermaid.min.js', import.meta.url);
      try {
        return await readFile(fileURLToPath(vendoredUrl), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // 3. Fall back to node_modules (local dev).
      const url = await import.meta.resolve('mermaid/dist/mermaid.min.js');
      return readFile(fileURLToPath(url), 'utf8');
    })().catch((err) => {
      // Don't let a rejected promise poison the cache: clearing it on
      // failure means a later export can retry after an operator fixes
      // the missing file or env var, without requiring a server
      // restart. Mirrors the `browserPromise = null` reset in pdf.ts
      // when `chromium.launch()` fails.
      mermaidUmdCache = null;
      throw err;
    });
  }
  return mermaidUmdCache;
}
