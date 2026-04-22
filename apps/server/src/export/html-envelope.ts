/**
 * Self-contained HTML document assembly for the PDF exporter.
 *
 * Takes the renderer's body HTML, the resolved theme CSS, the shared
 * print stylesheet, and per-document metadata, and produces a single
 * HTML string suitable for `page.setContent()` — no external asset
 * references (images are inlined as data URLs) and no external script
 * src (mermaid's UMD is inlined when present).
 *
 * Google Fonts `@import url(...)` lines in the theme CSS are left
 * alone — Chromium fetches those at load time and `document.fonts.ready`
 * gates the print.
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
  const imgRe = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gd;
  for (let m: RegExpExecArray | null; (m = imgRe.exec(html)); ) {
    const src = m[1]!;
    if (isAbsoluteUrl(src)) continue;
    const hit = attached.get(src);
    if (!hit) continue;
    const srcIndices = m.indices?.[1];
    if (!srcIndices) continue; // paranoia: requires the `d` flag to be set
    hits.push({
      start: srcIndices[0],
      end: srcIndices[1],
      ref: src,
      mime: hit.mime,
      assetId: hit.assetId,
    });
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
  return mime.replace(/[^a-zA-Z0-9/+.\-]/g, '');
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
