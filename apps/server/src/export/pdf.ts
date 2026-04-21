/**
 * PDF export via headless Chromium (Playwright).
 *
 * Architecture (see PROPOSAL_PDF_EXPORT.md §4):
 *   - One long-lived `Browser` instance, started lazily on the first
 *     export and kept alive for the life of the server process.
 *   - Each export runs in its own `BrowserContext` + `Page` so state
 *     never leaks between documents.
 *   - A semaphore caps concurrent exports (default 2) to bound RAM.
 *   - A hard 30 s timeout on each export; exceeding it aborts the page
 *     and surfaces `ExportTimeoutError`.
 *
 * The module exports three public entry points:
 *   - `exportPdf(opts)` — the one-shot happy path.
 *   - `closeExportBrowser()` — tear down the shared browser (called
 *     from `App.close()`).
 *   - `configureExport({ concurrency, timeoutMs })` — runtime knobs,
 *     mostly for tests.
 *
 * Error classes let the route handler map to HTTP status codes
 * without string-matching messages.
 */
import { type Browser, type BrowserContext, chromium } from 'playwright';

import { buildExportHtml, type EnvelopeMeta, loadMermaidUmd } from './html-envelope.js';

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface ExportPdfOptions {
  /** Rendered body HTML (already sanitized by the renderer). */
  body: string;
  /** Resolved theme CSS (with local `@imports` already inlined). */
  themeCss: string;
  /** Shared print stylesheet. */
  printCss: string;
  /** Document metadata forwarded to the HTML envelope + PDF core. */
  meta: EnvelopeMeta;
  /**
   * True iff the rendered body contains at least one mermaid block.
   * When true, the exporter inlines the mermaid runtime and waits on
   * `window.__marginaliaMermaidReady` before printing. Comes from
   * `renderResult.mermaid.length > 0`.
   */
  hasMermaid: boolean;
  /**
   * Optional external abort signal (e.g. from the HTTP request being
   * cancelled). Combined with the module-level timeout — whichever
   * fires first wins.
   */
  signal?: AbortSignal;
}

export class ExportEngineMissingError extends Error {
  readonly code = 'export-engine-missing';
  constructor(cause?: unknown) {
    // ES2022 `Error` accepts `{ cause }`; pass through so the original
    // Playwright error is preserved on `err.cause` for logging.
    super(
      'Playwright Chromium is not installed. Run `bunx playwright install chromium`.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'ExportEngineMissingError';
  }
}

export class ExportTimeoutError extends Error {
  readonly code = 'export-timeout';
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`PDF export timed out after ${elapsedMs} ms`);
    this.name = 'ExportTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

export class ExportBusyError extends Error {
  readonly code = 'export-busy';
  constructor() {
    super('PDF export queue is full; try again shortly.');
    this.name = 'ExportBusyError';
  }
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

interface Config {
  concurrency: number;
  /** Wall-clock budget per export, including browser context setup. */
  timeoutMs: number;
  /** Separate budget for the mermaid readiness wait. Shorter than
   * `timeoutMs` so a single bad diagram can't eat the whole budget. */
  mermaidWaitMs: number;
  /** Budget for `document.fonts.ready`. Short: if fonts don't load in
   * a few seconds, the export proceeds with fallbacks. */
  fontsWaitMs: number;
}

let config: Config = {
  concurrency: Number(process.env.MARGINALIA_PDF_CONCURRENCY) || 2,
  timeoutMs: Number(process.env.MARGINALIA_PDF_TIMEOUT_MS) || 30_000,
  mermaidWaitMs: Number(process.env.MARGINALIA_PDF_MERMAID_WAIT_MS) || 15_000,
  fontsWaitMs: Number(process.env.MARGINALIA_PDF_FONTS_WAIT_MS) || 3_000,
};

/** Override runtime config. Intended for tests; production tunes via
 * env vars at startup. */
export function configureExport(patch: Partial<Config>): void {
  config = { ...config, ...patch };
}

// ---------------------------------------------------------------------
// Browser lifecycle (shared singleton)
// ---------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        // `channel: 'chromium-headless-shell'` picks the slim (~300 MB
        // extracted) headless-only binary instead of the full Chrome
        // for Testing bundle. Both are built from the same Chromium
        // source and produce byte-identical PDFs for our inputs, but
        // the shell is ~200 MB smaller on disk — worth it for the
        // Docker image size. Requires
        // `playwright install chromium-headless-shell` to have run
        // (see Dockerfile); locally fall back to whatever the dev box
        // has installed via the env override below.
        //
        // `headless: true` is redundant with the shell channel but
        // pinned explicitly for future-proofing.
        //
        // MARGINALIA_PDF_CHANNEL lets operators override — e.g. to
        // `'chromium'` when debugging against a local full-Chrome
        // install, or to `''` to let Playwright pick its default.
        const channelOverride = process.env.MARGINALIA_PDF_CHANNEL;
        const channel =
          channelOverride === undefined ? 'chromium-headless-shell' : channelOverride;
        return await chromium.launch({
          headless: true,
          ...(channel ? { channel } : {}),
        });
      } catch (err) {
        // Clear the cached promise so the next request retries (typical
        // cause: Chromium not installed on a fresh deploy). Surface a
        // typed error so the route can map to a helpful HTTP response.
        browserPromise = null;
        if (isBrowserMissing(err)) throw new ExportEngineMissingError(err);
        throw err;
      }
    })();
  }
  return browserPromise;
}

/**
 * Playwright throws a generic `Error` when the browser binary is
 * absent; the message includes `Executable doesn't exist` and a
 * `playwright install` hint. Match defensively.
 */
function isBrowserMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("Executable doesn't exist") ||
    m.includes('playwright install') ||
    m.includes('BrowserType.launch')
  );
}

/**
 * Tear down the shared browser. Idempotent — safe to call from both
 * `App.close()` and a test's `afterEach`. If the browser never
 * launched, this resolves immediately.
 *
 * Also resets the semaphore: if a test's `exportPdf()` call timed
 * out at the bun-test level, its `release()` never ran, leaving
 * `inFlight` stuck at a non-zero value across tests. Zeroing it
 * here turns every teardown into a true clean slate.
 */
export async function closeExportBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  inFlight = 0;
  waiters.length = 0;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Already closed / crashed — nothing to do.
  }
}

// ---------------------------------------------------------------------
// Semaphore (concurrency cap)
// ---------------------------------------------------------------------

let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Try to acquire a slot without waiting. Returns a release function on
 * success, or null if the queue is full. A waiting-queue would also
 * work but for v1 we prefer the caller (HTTP handler) to get an
 * immediate 503 rather than quietly queueing — the latter hides load
 * problems.
 */
function tryAcquireSlot(): (() => void) | null {
  if (inFlight >= config.concurrency) return null;
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

/**
 * Render the given body+theme+print CSS bundle to a PDF byte buffer.
 *
 * Flow:
 *   1. Acquire a semaphore slot (503 if full).
 *   2. Get the shared browser (lazy-init on first call).
 *   3. Create a fresh `BrowserContext` + `Page`.
 *   4. `page.setContent(html, { waitUntil: 'networkidle' })` — lets
 *      Google-Fonts `@import`s resolve.
 *   5. Wait for `document.fonts.ready` (with a short budget).
 *   6. If the doc had mermaid blocks, wait for the bootstrapper's
 *      `window.__marginaliaMermaidReady` sentinel.
 *   7. `page.emulateMedia({ media: 'print' })` + `page.pdf(...)` with
 *      `preferCSSPageSize: true` so the @page rules in _print.css win.
 *   8. Close the context, release the slot, return the buffer.
 *
 * Errors are narrowed to the three public classes above; anything
 * unexpected propagates as a generic `Error` (500 at the route).
 */
export async function exportPdf(opts: ExportPdfOptions): Promise<Uint8Array> {
  const release = tryAcquireSlot();
  if (!release) throw new ExportBusyError();

  const started = Date.now();
  let context: BrowserContext | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Best-effort abort — closing the context cancels in-flight work.
    // The awaited page.pdf() promise rejects and we surface
    // ExportTimeoutError below.
    context?.close().catch(() => void 0);
  }, config.timeoutMs);

  // Mirror the external signal into the same abort path. Caller cancel
  // (e.g. client disconnected) is treated the same as a timeout from
  // the exporter's POV: close the context, reject.
  const onExternalAbort = () => {
    timedOut = true;
    context?.close().catch(() => void 0);
  };
  opts.signal?.addEventListener('abort', onExternalAbort);

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      // Disable service workers and the default permissions stack —
      // we never want an export page to persist anything or pop a
      // permission prompt (even in headless, the UI is absent but the
      // plumbing still runs).
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    // Conditional spread — `mermaidUmd` is only present on the object
    // when we actually loaded it, so `exactOptionalPropertyTypes`
    // doesn't complain about a `string | undefined` slot on a
    // `mermaidUmd?: string` field.
    const mermaidUmd = opts.hasMermaid ? await loadMermaidUmd() : null;
    const html = buildExportHtml({
      ...opts,
      ...(mermaidUmd !== null ? { mermaidUmd } : {}),
    });

    // `waitUntil: 'load'` is a far more reliable signal than
    // 'networkidle' for `setContent()` — Playwright's idle tracker
    // doesn't always converge when the initial load has no navigations,
    // and we saw 30 s hangs on simple documents as a result. `'load'`
    // fires after subresources (our inlined CSS + optional inlined
    // mermaid UMD) finish parsing, which is what we actually need.
    //
    // Google Fonts still have to finish loading for print fidelity; we
    // handle those separately via `document.fonts.ready` below.
    await page.setContent(html, {
      waitUntil: 'load',
      timeout: config.timeoutMs,
    });

    // Fonts: best-effort, short budget. We don't fail the export if a
    // web font never resolves — it just falls back to the theme's
    // system-font chain. The Promise.race is evaluated INSIDE the
    // page so the AbortController / module-level timer can unwind
    // cleanly if the context is closed mid-wait.
    await page
      .evaluate(
        (ms) =>
          Promise.race([
            document.fonts.ready.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
          ]),
        config.fontsWaitMs,
      )
      .catch(() => void 0);

    if (opts.hasMermaid) {
      // Wait up to `mermaidWaitMs` for the bootstrap sentinel. A bad
      // diagram inside the boot script is swallowed (see html-envelope),
      // so this only actually stalls if mermaid itself hangs — cap at
      // 15 s so a pathological doc can't eat the whole export budget.
      await page.waitForFunction(
        () =>
          (window as unknown as { __marginaliaMermaidReady?: boolean }).__marginaliaMermaidReady ===
          true,
        undefined,
        { timeout: config.mermaidWaitMs },
      );
    }

    await page.emulateMedia({ media: 'print' });

    // `preferCSSPageSize: true` means @page in _print.css wins over the
    // `format` option. `margin: { … 0 }` disables the Chromium default
    // so our @page margins aren't double-applied.
    const buf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    return buf;
  } catch (err) {
    if (timedOut) throw new ExportTimeoutError(Date.now() - started);

    // Chromium crash mid-export: clear the singleton so the next call
    // re-launches. Playwright surfaces this as "Target closed" /
    // "browserContext.close: Browser has been closed" — match
    // conservatively.
    if (
      err instanceof Error &&
      /Target (page, context or browser has been )?closed|Browser has been closed/i.test(
        err.message,
      )
    ) {
      void closeExportBrowser();
    }
    if (isBrowserMissing(err)) throw new ExportEngineMissingError(err);
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    try {
      await context?.close();
    } catch {
      // Already closed (timeout path) — nothing to do.
    }
    release();
  }
}
