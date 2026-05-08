/**
 * Mermaid renderer #2: real mermaid.js inside headless Chromium.
 *
 * Where `mermaid-rust.ts` (mmdr) trades fidelity for speed and a
 * tiny binary, this module trades the other way — visual output
 * matches the in-browser viewer pixel-for-pixel, at the cost of
 * spinning up a `BrowserContext` per diagram. Use it for documents
 * where mmdr's "different but not wrong" output is wrong enough to
 * matter (the per-document `mermaid_renderer` setting picks).
 *
 * The browser instance is borrowed from `pdf.ts` — there's no second
 * Chromium launch in the process. Each render gets a fresh
 * `BrowserContext` so state never leaks across diagrams.
 */
import type { Browser, BrowserContext } from 'playwright';
import { loadMermaidUmd } from './html-envelope.js';
import {
  type MermaidImageFormat,
  MermaidRenderEngineMissingError,
  MermaidRenderError,
  MermaidRenderTimeoutError,
  type RenderedMermaidImage,
} from './mermaid-rust.js';
import {
  ALLOWED_EXPORT_HOSTS,
  getBrowser,
  ExportEngineMissingError as PdfEngineMissingError,
} from './pdf.js';

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

interface Config {
  /**
   * Per-render budget. Mermaid runs reasonably fast inside Chromium
   * (a few hundred ms for typical diagrams), but a pathological
   * input shouldn't be allowed to wedge an export. Shorter than the
   * PDF total budget so a bad diagram falls back to the placeholder
   * before the export itself times out.
   */
  timeoutMs: number;
  /**
   * Image scale (device pixel ratio) for PNG output. 4× by default
   * so embedded diagrams stay sharp at high zoom in Word and at
   * print resolution (Word renders at 96 DPI by default; printers
   * typically run at 300+ DPI, ~3.1× the screen density). The
   * resolver pairs the high-res raster with explicit display CSS-
   * pixel dimensions, so Word displays the diagram at its natural
   * size with a 4× pixel reservoir to draw on.
   *
   * Tradeoff: PNG bytes grow ~16× vs 1×. For typical diagrams that
   * means tens of KB → hundreds of KB; still small enough that
   * docx file size stays reasonable on documents with a handful
   * of diagrams. Lower this knob (e.g. to 2 or 3) on memory-
   * constrained hosts.
   */
  pngScale: number;
}

let config: Config = readConfigFromEnv();

function readConfigFromEnv(): Config {
  const t = process.env.MARGINALIA_MERMAID_CHROMIUM_TIMEOUT_MS;
  const timeoutMs = t && Number.isInteger(Number(t)) && Number(t) >= 100 ? Number(t) : 15_000;
  const s = process.env.MARGINALIA_MERMAID_CHROMIUM_PNG_SCALE;
  const pngScale = s && Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : 4;
  return { timeoutMs, pngScale };
}

/** Override config — for tests. */
export function configureMermaidChromium(patch: Partial<Config>): void {
  config = { ...config, ...patch };
}

export function getMermaidChromiumConfig(): Readonly<Config> {
  return config;
}

// ---------------------------------------------------------------------
// Page bootstrap (cached)
// ---------------------------------------------------------------------

/**
 * The mermaid UMD is ~3 MB; reading + parsing it is the slowest step
 * of a Chromium-based render. Cache the bytes once at module load
 * (lazy) and reuse across renders. The shared `loadMermaidUmd()`
 * already memoises internally, but we wrap it here so a missing
 * binary surfaces as our typed error rather than the PDF route's.
 */
async function loadUmd(): Promise<string> {
  try {
    return await loadMermaidUmd();
  } catch (err) {
    throw new MermaidRenderEngineMissingError('mermaid (UMD bundle)', err as NodeJS.ErrnoException);
  }
}

/**
 * Static HTML scaffold that hosts a single mermaid diagram. The UMD
 * is inlined so the page has no external dependencies (the export
 * Chromium's outbound-request firewall would block them anyway).
 */
function buildPageHtml(umd: string, source: string): string {
  // `source` is the raw mermaid text. We JSON-stringify it here
  // before embedding into the inline script so arbitrary characters
  // (including closing `</script>` sequences in user diagrams)
  // survive into the page as a plain string literal.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mermaid render</title>
<style>
  html, body { margin: 0; padding: 0; background: white; }
  #host { display: inline-block; padding: 8px; background: white; }
  #host svg { display: block; }
</style>
</head>
<body>
<div id="host"></div>
<script>${umd}</script>
<script>
(async () => {
  try {
    if (!window.mermaid) {
      window.__marginaliaMermaidError = 'runtime not present';
      window.__marginaliaMermaidReady = true;
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
    const source = ${JSON.stringify(source)};
    const { svg } = await window.mermaid.render('marginalia-diagram', source);
    document.getElementById('host').innerHTML = svg;
    window.__marginaliaMermaidSvg = svg;
  } catch (err) {
    window.__marginaliaMermaidError = (err && err.message) || String(err);
  } finally {
    window.__marginaliaMermaidReady = true;
  }
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------

/**
 * Render a single mermaid source string to either SVG or PNG bytes
 * via real mermaid.js inside Chromium. Returns `null` on parse /
 * render failure (mirrors `mermaid-rust.ts` so the DOCX/PDF caller
 * can fall back to the labeled-code-block stopgap without changing
 * its branching). The engine-missing case still throws.
 *
 * For SVG: returns mermaid's own SVG output unmodified.
 * For PNG: screenshots the SVG element at `config.pngScale` device
 * pixel ratio so output is sharp at typical Word zoom levels.
 */
export async function renderMermaidWithChromium(
  source: string,
  format: MermaidImageFormat = 'png',
): Promise<RenderedMermaidImage | null> {
  const umd = await loadUmd();

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    // PDF's launcher surfaces a missing-binary failure as a typed
    // error; translate to ours so the route's `instanceof` check
    // (which knows MermaidRenderEngineMissingError) fires
    // consistently regardless of which engine the caller picked.
    if (err instanceof PdfEngineMissingError) {
      throw new MermaidRenderEngineMissingError('chromium', err);
    }
    throw err;
  }

  const html = buildPageHtml(umd, source);
  let context: BrowserContext | null = null;
  const started = Date.now();

  try {
    context = await browser.newContext({
      serviceWorkers: 'block',
      deviceScaleFactor: format === 'png' ? config.pngScale : 1,
    });
    const page = await context.newPage();

    // Outbound-request firewall — mirrors `pdf.ts`. The page is
    // self-contained (UMD inlined, no external resources), but
    // belt-and-braces in case a mermaid theme tries to fetch fonts
    // or anything else.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      try {
        const { protocol, hostname } = new URL(url);
        if (protocol === 'https:' && ALLOWED_EXPORT_HOSTS.has(hostname)) {
          return route.continue();
        }
      } catch {
        // unparseable URL → abort
      }
      return route.abort('blockedbyclient');
    });

    await page.setContent(html, { waitUntil: 'load', timeout: config.timeoutMs });

    // Wait for the bootstrap to finish (success OR failure — the
    // sentinel is set in both branches). Per-action timeout slightly
    // shorter than the total budget so we get a typed timeout
    // instead of an opaque playwright one.
    try {
      await page.waitForFunction(
        () =>
          (window as unknown as { __marginaliaMermaidReady?: boolean }).__marginaliaMermaidReady ===
          true,
        undefined,
        { timeout: config.timeoutMs },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new MermaidRenderTimeoutError(Date.now() - started);
      }
      throw err;
    }

    // Read whatever the bootstrap left on the window.
    const probe = await page.evaluate(() => {
      const w = window as unknown as {
        __marginaliaMermaidError?: string;
        __marginaliaMermaidSvg?: string;
      };
      return { error: w.__marginaliaMermaidError, svg: w.__marginaliaMermaidSvg };
    });

    if (probe.error || !probe.svg) {
      // Parse / render failure: behave like mmdr's "return null so
      // the caller can fall back". The error string is informative
      // for ad-hoc debugging via tests, but we don't surface it to
      // the client.
      return null;
    }

    // Read the host's CSS-pixel bounding box BEFORE we take the
    // screenshot. This is the natural display size of the diagram
    // (independent of `deviceScaleFactor`); we hand it back so the
    // DOCX exporter can tell Word "display at this size" while the
    // PNG bytes carry `deviceScaleFactor`× more actual pixels.
    // Without this hand-off, a 4×-resolution PNG would scale up the
    // diagram visually 4× — wrong direction.
    const naturalSize = await page.evaluate(() => {
      const el = document.getElementById('host');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });

    if (format === 'svg') {
      const svgResult: RenderedMermaidImage = {
        bytes: new TextEncoder().encode(probe.svg),
        mime: 'image/svg+xml',
        format: 'svg',
      };
      if (naturalSize) {
        svgResult.naturalWidth = naturalSize.width;
        svgResult.naturalHeight = naturalSize.height;
      }
      return svgResult;
    }

    // PNG: screenshot the host div at the configured scale. The host
    // sets explicit white background + `inline-block` so the
    // screenshot crops to the SVG bounding box without odd margins.
    const host = page.locator('#host');
    const png = await host.screenshot({ type: 'png', omitBackground: false });
    const pngResult: RenderedMermaidImage = {
      bytes: png,
      mime: 'image/png',
      format: 'png',
    };
    if (naturalSize) {
      pngResult.naturalWidth = naturalSize.width;
      pngResult.naturalHeight = naturalSize.height;
    }
    return pngResult;
  } catch (err) {
    if (err instanceof MermaidRenderEngineMissingError) throw err;
    if (err instanceof MermaidRenderTimeoutError) throw err;
    // Anything else is an unexpected Playwright/Chromium error —
    // treat it as a render failure (return null) so a single bad
    // diagram doesn't fail the whole export. Distinguishing from
    // engine-missing is by class only.
    if (err instanceof Error && /Target.*closed|Browser has been closed/i.test(err.message)) {
      // Browser died mid-render. Surface as a render error (typed)
      // so tests can assert on it; the DOCX route will swallow it
      // and fall back per per-diagram policy.
      throw new MermaidRenderError(`Mermaid Chromium session closed: ${err.message}`, '');
    }
    return null;
  } finally {
    try {
      await context?.close();
    } catch {
      // already closed
    }
  }
}
