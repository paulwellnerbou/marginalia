/**
 * PDF export via headless Chromium (Playwright).
 *
 * Architecture (see apps/server/PDF_EXPORT.md):
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
      'Playwright Chromium is not installed. Run `bunx playwright install chromium-headless-shell`.',
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

/**
 * Parse and validate a positive-integer env var. Empty / unset → use
 * the default. Any other value must parse cleanly to an integer >= 1,
 * otherwise we throw — misconfiguration should break startup loudly,
 * not produce a server that silently rejects every export with 503
 * (the old `Number(env) || default` let `MARGINALIA_PDF_CONCURRENCY=-1`
 * pass through and made `inFlight >= concurrency` always true).
 */
function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/** Validate a single config patch value. Used by `configureExport()`. */
function assertPositiveInt(name: keyof Config, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${value}`);
  }
  return value;
}

let config: Config = {
  concurrency: parsePositiveIntEnv('MARGINALIA_PDF_CONCURRENCY', 2),
  timeoutMs: parsePositiveIntEnv('MARGINALIA_PDF_TIMEOUT_MS', 30_000),
  mermaidWaitMs: parsePositiveIntEnv('MARGINALIA_PDF_MERMAID_WAIT_MS', 15_000),
  fontsWaitMs: parsePositiveIntEnv('MARGINALIA_PDF_FONTS_WAIT_MS', 3_000),
};

/**
 * Override runtime config. Intended for tests; production tunes via
 * env vars at startup. All fields are positive-integer-validated —
 * a test that passes `{ concurrency: 0 }` or a negative timeout
 * throws immediately instead of silently breaking the suite.
 */
export function configureExport(patch: Partial<Config>): void {
  const validated: Partial<Config> = {};
  for (const [k, v] of Object.entries(patch) as [keyof Config, number][]) {
    if (v !== undefined) validated[k] = assertPositiveInt(k, v);
  }
  config = { ...config, ...validated };
}

/**
 * Hostnames the export Chromium is allowed to reach over HTTP(S).
 * Everything else is aborted at the request-routing layer (see
 * `exportPdf` below) — this is the main SSRF mitigation, since the
 * rendered document and theme CSS can contain user-authored
 * absolute URLs.
 *
 * Narrow on purpose: these are the fonts origins used by the
 * built-in themes (`beautiful`, `handbook`, `asciidoc-article`) via
 * `@import url(...)` at the top of their CSS files. Anything not on
 * this list is declined.
 *
 * Operators who bundle additional themes that pull fonts from other
 * CDNs can extend this via `MARGINALIA_PDF_ALLOWED_HOSTS` (comma-
 * separated hostnames). The env override is opt-in so the default
 * posture stays restrictive.
 *
 * Security notes for operators adding hosts:
 *   - Every hostname on this list is reachable from the export
 *     Chromium. Anything on it expands the SSRF surface — a
 *     user-authored document that manages to reference an
 *     allowlisted host can cause a request from the worker's
 *     network position.
 *   - Prefer narrowly-scoped hostnames (e.g. `cdn.example.com`)
 *     over broad ones (e.g. `example.com` — risks allowing any
 *     subdomain under it once DNS resolves).
 *   - Only `https:` traffic is ever allowed, even for allowlisted
 *     hosts — see the firewall in `exportPdf`. Cleartext HTTP
 *     stays blocked regardless of what's in this list.
 *   - This is hostname-based; it does NOT protect against
 *     DNS-rebinding. If that's a concern for your deployment,
 *     the right place to layer post-resolve IP-range checks is
 *     the same page.route handler in `exportPdf`.
 */
export const ALLOWED_EXPORT_HOSTS = new Set<string>(
  ['fonts.googleapis.com', 'fonts.gstatic.com'].concat(
    (process.env.MARGINALIA_PDF_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
  ),
);

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
 * Detect Playwright's `TimeoutError`. We want to normalize these to
 * our `ExportTimeoutError` (→ 504) so the frontend sees the typed
 * contract, not a generic 500.
 *
 * Checked by `name` rather than `instanceof` — importing
 * `playwright.errors.TimeoutError` directly binds us to Playwright's
 * internal module layout (the `errors` subpath has moved between
 * versions). The `name` field is part of the public surface and has
 * been stable since Playwright 1.0.
 */
function isPlaywrightTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
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
 * Also bumps the semaphore generation and resets `inFlight` to zero.
 * The generation token makes this safe even when an in-flight export
 * is still running: the late `release()` callback captures the
 * generation from its acquire, and a mismatch at release time means
 * "your accounting is from a previous lifetime — don't touch the
 * current counter". Without the generation check, a late release
 * could drive `inFlight` negative and silently raise the effective
 * concurrency cap for future exports.
 */
export async function closeExportBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  semaphoreGeneration += 1;
  inFlight = 0;
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
/**
 * Bumped by `closeExportBrowser()`. Each slot acquisition captures
 * the current generation; releases from a prior generation become
 * no-ops so the counter can be safely reset during teardown without
 * risking underflow from a still-unfinished export's `finally`.
 */
let semaphoreGeneration = 0;

/**
 * Try to acquire a slot without waiting. Returns a release function on
 * success, or null if the cap is already reached. Deliberately no
 * waiting-queue: the HTTP handler should surface an immediate 503
 * rather than quietly queueing. A queue would hide load problems.
 */
function tryAcquireSlot(): (() => void) | null {
  if (inFlight >= config.concurrency) return null;
  inFlight += 1;
  const myGeneration = semaphoreGeneration;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // If teardown bumped the generation between acquire and release,
    // our slot has already been accounted for by closeExportBrowser.
    // Don't touch inFlight — doing so would drive the counter negative
    // and silently raise the effective cap for later exports.
    if (myGeneration !== semaphoreGeneration) return;
    inFlight = Math.max(0, inFlight - 1);
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
 *   4. `page.setContent(html, { waitUntil: 'load' })` — fires after
 *      inlined subresources (our CSS + optional mermaid UMD) parse.
 *      `'networkidle'` would be more thorough on paper but is flaky
 *      with `setContent()` — we saw 30 s hangs on simple documents.
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

  // `abortPromise` rejects when the timer fires OR the external signal
  // aborts. Racing every major step against it makes the hard timeout
  // actually bite even when the hang is pre-context (e.g. `getBrowser()`
  // or `browser.newContext()` stalling). Without the race, a flipped
  // `timedOut` flag does nothing — there's no context to close, so the
  // pending `await` just keeps waiting forever and the semaphore slot
  // is held past the advertised deadline.
  //
  // `.catch(() => void 0)` suppresses the unhandled-rejection warning
  // when the happy path resolves before we ever observe the abort
  // promise. The race's loser is always observed, so the catch is
  // only for the "we completed cleanly but the timer hadn't fired
  // yet" window.
  let abortReject: ((err: Error) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  abortPromise.catch(() => void 0);

  const abortExport = (err: Error): void => {
    if (timedOut) return;
    timedOut = true;
    // Best-effort abort — closing the context cancels in-flight work.
    // Works for late-stage hangs (page.pdf, setContent). For
    // pre-context hangs, the raced abortPromise is what unblocks
    // the outer await.
    context?.close().catch(() => void 0);
    abortReject?.(err);
  };

  const timer = setTimeout(() => {
    abortExport(new ExportTimeoutError(Date.now() - started));
  }, config.timeoutMs);

  // Mirror the external signal into the same abort path. Caller cancel
  // (e.g. client disconnected) is treated the same as a timeout from
  // the exporter's POV: close the context, reject.
  //
  // The `.aborted` pre-check handles the case where the request was
  // already cancelled before we got here (e.g. client gave up during
  // the theme CSS read that happens before exportPdf is called).
  // Without it, the `addEventListener` registers too late and we'd
  // burn a semaphore slot producing bytes no one will read.
  //
  // `once: true` lets the runtime reclaim the listener immediately
  // after firing — defensive, since we're about to abort anyway.
  const onExternalAbort = () => {
    abortExport(new ExportTimeoutError(Date.now() - started));
  };
  if (opts.signal?.aborted) {
    onExternalAbort();
  } else {
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  /**
   * Race any promise against the abort signal. Once the abort fires,
   * every subsequent `race()` call short-circuits to the same
   * rejection, so the export unwinds as soon as the currently-awaited
   * step completes (or immediately, if the abort won).
   */
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, abortPromise]);

  try {
    const browser = await race(getBrowser());
    context = await race(
      browser.newContext({
        // Disable service workers and the default permissions stack —
        // we never want an export page to persist anything or pop a
        // permission prompt (even in headless, the UI is absent but the
        // plumbing still runs).
        serviceWorkers: 'block',
      }),
    );
    const page = await race(context.newPage());

    // Outbound-request firewall. The rendered document can contain
    // user-authored absolute URLs (e.g. `<img src="http://internal/">`)
    // and theme CSS can carry `@import url('https://fonts.googleapis.com/…')`.
    // Without filtering, a malicious document could make the server's
    // Chromium probe internal networks or pull attacker-controlled
    // content into the PDF — a classic SSRF vector.
    //
    // Policy: abort EVERYTHING except the initial `about:blank`
    // document and fetches to the Google Fonts origins the built-in
    // themes use. Every other URL (user-authored image hosts,
    // `<link rel>`, redirects, XHR, etc.) aborts at the routing layer
    // before Chromium can issue the request.
    //
    // Local asset refs never reach this layer — they were already
    // inlined as `data:` URLs by inlineImageAssets() in the HTML
    // envelope.
    await race(page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) {
        return route.continue();
      }
      try {
        const { protocol, hostname } = new URL(url);
        // `https:` only — no cleartext HTTP even for allowlisted hosts.
        // Protects against MITM-triggered content swaps and stops
        // anyone with network-path access from coaxing the worker
        // into a downgrade attack via a user-authored `http://…`
        // asset that happens to resolve to an allowlist hostname.
        if (protocol === 'https:' && ALLOWED_EXPORT_HOSTS.has(hostname)) {
          return route.continue();
        }
      } catch {
        // Unparseable URL — fall through to abort.
      }
      return route.abort('blockedbyclient');
    }));

    // Conditional spread — `mermaidUmd` is only present on the object
    // when we actually loaded it, so `exactOptionalPropertyTypes`
    // doesn't complain about a `string | undefined` slot on a
    // `mermaidUmd?: string` field.
    const mermaidUmd = opts.hasMermaid ? await race(loadMermaidUmd()) : null;
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
    // Playwright's own `timeout` here backs up the module-level
    // `race(abortPromise)` — whichever fires first wins. If it's
    // Playwright's, the resulting `TimeoutError` is normalized to
    // our `ExportTimeoutError` in the catch path (so the route
    // returns 504, not a generic 500). Keeping both so the
    // Playwright-level timeout still acts as a safety net against
    // any case where the module timer's close-context path fails.
    await race(
      page.setContent(html, {
        waitUntil: 'load',
        timeout: config.timeoutMs,
      }),
    );

    // Fonts: best-effort, short budget. We don't fail the export if a
    // web font never resolves — it just falls back to the theme's
    // system-font chain. The Promise.race is evaluated INSIDE the
    // page so the AbortController / module-level timer can unwind
    // cleanly if the context is closed mid-wait.
    await race(
      page
        .evaluate(
          (ms) =>
            Promise.race([
              document.fonts.ready.then(() => true),
              new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
            ]),
          config.fontsWaitMs,
        )
        .catch(() => void 0),
    );

    if (opts.hasMermaid) {
      // Wait up to `mermaidWaitMs` for the bootstrap sentinel. A bad
      // diagram inside the boot script is swallowed (see html-envelope),
      // so this only actually stalls if mermaid itself hangs — cap at
      // 15 s so a pathological doc can't eat the whole export budget.
      //
      // This is the ONE place we intentionally rely on a Playwright
      // per-action timeout (shorter than the total export budget).
      // Convert its `TimeoutError` to our `ExportTimeoutError` so the
      // route returns 504 instead of a generic 500.
      try {
        await race(
          page.waitForFunction(
            () =>
              (window as unknown as { __marginaliaMermaidReady?: boolean })
                .__marginaliaMermaidReady === true,
            undefined,
            { timeout: config.mermaidWaitMs },
          ),
        );
      } catch (err) {
        if (isPlaywrightTimeoutError(err)) {
          throw new ExportTimeoutError(Date.now() - started);
        }
        throw err;
      }
    }

    await race(page.emulateMedia({ media: 'print' }));

    // `preferCSSPageSize: true` means @page in _print.css wins over the
    // `format` option. `margin: { … 0 }` disables the Chromium default
    // so our @page margins aren't double-applied.
    const buf = await race(
      page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      }),
    );

    return buf;
  } catch (err) {
    // A timeout/abort path produces an `ExportTimeoutError` directly
    // from `abortPromise`, so re-throw it untouched. The second check
    // covers the narrow window where the timer fired but something
    // else raced to throw first.
    if (err instanceof ExportTimeoutError) throw err;
    if (timedOut) throw new ExportTimeoutError(Date.now() - started);

    // Belt-and-braces: normalize any Playwright TimeoutError that
    // still reaches this catch block into the typed HTTP contract.
    // The main timeout/abort path comes from `abortPromise`; the
    // mermaid wait and `setContent` also use explicit Playwright
    // timeouts. This catches anything else that surfaces as a
    // Playwright timeout (e.g. default-timeout of a surface we
    // didn't silence explicitly).
    if (isPlaywrightTimeoutError(err)) {
      throw new ExportTimeoutError(Date.now() - started);
    }

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
