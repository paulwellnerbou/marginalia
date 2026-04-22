# PDF Export

`GET /api/documents/:uid/export.pdf?theme=<name>` renders a Marginalia
document to a themed, print-friendly PDF. Implemented in
[`src/export/`](./src/export/); the public route lives beside its DOCX
sibling in [`src/routes/documents.ts`](./src/routes/documents.ts).

The exporter runs the document through the shared renderer, wraps the
result in a self-contained HTML envelope, and prints via headless
Chromium (Playwright). No external JS is fetched at render time —
mermaid's UMD is vendored and inlined; an outbound-request firewall
blocks everything but a small allowlist of font CDNs.

## Request flow

```
apps/web ──► "PDF document (.pdf)" item in the toolbar DownloadMenu
             │ (download icon next to the gear, available to readers)
apps/server ─► GET /api/documents/:uid/export.pdf?theme=<name>
             │ authorize + load source + list attached blobs
             │ renderDocument(source, { mermaid: 'client' })
             │ inlineImageAssets(html, attached, blobs)      ← document-local refs → data: URLs
             │ loadThemeCss(theme) + loadPrintCss()           ← recursive @import inlining
             ▼
apps/server/src/export/pdf.ts
             │ semaphore.acquire (503 if full)
             │ shared Chromium → newContext → newPage
             │ page.route('**/*', …)                         ← outbound firewall
             │ page.setContent(envelope, { waitUntil: 'load' })
             │ document.fonts.ready                           ← short budget
             │ mermaid.run() → __marginaliaMermaidReady       ← if hasMermaid
             │ page.emulateMedia({ media: 'print' })
             │ page.pdf({ preferCSSPageSize: true, printBackground: true })
             ▼
           .pdf file download
```

The renderer already sanitises HTML via `rehype-sanitize` before any of
this runs; the exporter appends no untrusted HTML of its own.

## Content mapping

| Source / rendered element | PDF treatment |
|---|---|
| Headings | Clickable internal anchors (heading IDs survive). Print CSS adds `break-after: avoid` so a heading doesn't end a page alone. |
| Paragraphs / lists | Standard. `orphans: 3; widows: 3` on paragraphs and list items to suppress lonely-line page breaks. |
| Code blocks (Shiki) | Inline colored spans from Shiki — no JS execution needed, paint direct. |
| Tables (GFM) | Kept together when possible (`break-inside: avoid-page`). |
| Blockquotes / figures / mermaid diagrams | `break-inside: avoid-page`. |
| Images | Document-local blob refs inlined as `data:` URLs before rendering. Absolute URLs are **blocked by the firewall** — they don't render. |
| Mermaid blocks | Rendered to SVG inside the export page by the inlined mermaid UMD (`mermaid.run()`), then printed. If a diagram fails to parse, the raw source renders in a dashed frame (from `_print.css`). |
| Links | Preserved as clickable annotations in the PDF. The print stylesheet strips the default UA-added `(URL)` suffix and keeps link text inherited-colored but underlined. |
| TOC marker (`[TOC]` / `[[_TOC_]]`) | Hidden in print in v1. No auto-generated PDF outline. (Follow-up.) |
| Heading-anchor sigils, comment gutter, block-action affordances | `display: none` in print — they're viewer chrome, not content. |
| Comments | Not rendered in v1. (Follow-up: `?comments=inline|appendix`.) |

All styling flows through the theme's CSS (from `@marginalia/themes`)
plus the shared [`_print.css`](../../packages/themes/css/_print.css).
The print stylesheet is concatenated AFTER the theme, so on
equal-specificity conflicts the print layer wins — this gives every
theme a known print baseline (page box, page breaks, UI-chrome
suppression) without needing per-theme print rules. A theme that
wants to diverge from the baseline needs either higher specificity
or `!important`.

## Security posture

- **Auth**: identical to `GET /api/documents/:uid` — same
  `authorizeRequest()` path, same invite / password-session / admin
  rules. If a viewer can read the doc, they can export it.
- **HTML sanitisation**: the renderer pipes through `rehype-sanitize`
  before the exporter touches anything. No DOM-injected user HTML.
- **Outbound-request firewall**: every fetch the export page tries is
  routed through `page.route('**/*', …)` in
  [`src/export/pdf.ts`](./src/export/pdf.ts). The allowlist
  (`ALLOWED_EXPORT_HOSTS`) contains only `fonts.googleapis.com` and
  `fonts.gstatic.com` by default. Everything else — user-authored
  `<img src="http://…">`, third-party `<link>` tags, XHR from the
  vendored mermaid — is aborted. Closes the SSRF class of bugs.
- **Theme name validation**: `isValidThemeName()` gates the `?theme=`
  query against `^[a-z][a-z0-9-]{0,40}$` before the CSS loader
  touches the filesystem, so a path-traversal-shaped theme name
  can't escape the themes directory.
- **Filesystem isolation**: the export page is fed a fully inlined
  HTML string via `setContent()`. No `file://` navigation, no base
  URL, no relative-URL resolution against anything on disk.
- **Chromium sandbox**: default — we don't pass `--no-sandbox`.
- **Chromium lifecycle**: a single long-lived `Browser` is reused
  across exports, but each export gets a fresh `BrowserContext` so
  no cookies, storage, or service-worker state carries between
  documents. Service workers are explicitly blocked at context
  creation.

## Edge cases

- **Chromium not installed**: the handler returns 500 with
  `{ error: 'export-engine-missing', hint: '…' }`. The frontend
  shows a specific toast pointing at
  `bunx playwright install chromium-headless-shell`.
- **Export queue full**: 503 with `Retry-After: 2`. The UI surfaces
  "another export is in progress, try again" — the client does not
  retry automatically in v1; the `Retry-After` header is present for
  callers (cli, scripts) that want to respect it.
- **Export timeout** (30 s by default): 504 with
  `{ error: 'export-timeout', elapsed_ms }`. Timeout races every
  await inside `exportPdf` via an `abortPromise`, so even a stalled
  `getBrowser()` or `browser.newContext()` can't outlive the budget.
- **Client disconnect**: the request's `AbortSignal` is wired into
  the same abort path as the timeout. The export aborts promptly,
  the semaphore slot is freed.
- **Semaphore safety across teardown**: each acquire captures a
  generation token; `closeExportBrowser()` bumps the generation,
  so a late `release()` from an in-flight export doesn't underflow
  the counter or raise the effective concurrency cap.
- **Dark-mode themes**: forced to light-on-white at print time by
  `_print.css`. Themes that only supply dark-mode variables still
  produce a readable PDF.
- **Missing mermaid / failed diagram**: mermaid errors are swallowed
  by the bootstrap; the `__marginaliaMermaidReady` sentinel always
  resolves. Failed diagrams render as dashed-frame raw source (see
  `_print.css`). One bad diagram doesn't tank an export.
- **Very large documents**: no special handling in v1. Hitting the
  30 s timeout is the signal to revisit.

## Configuration

All knobs are env-var-tuned at startup; defaults are sensible for a
single-tenant deploy. Tests override via `configureExport()`.

| Env var | Default | Purpose |
|---|---|---|
| `MARGINALIA_PDF_CONCURRENCY` | `2` | Max concurrent exports. Over the cap → 503. |
| `MARGINALIA_PDF_TIMEOUT_MS` | `30000` | Hard per-export budget, including browser launch. |
| `MARGINALIA_PDF_MERMAID_WAIT_MS` | `15000` | Budget for waiting on `__marginaliaMermaidReady`. |
| `MARGINALIA_PDF_FONTS_WAIT_MS` | `3000` | Budget for `document.fonts.ready`. Exports proceed with fallback fonts if exceeded. |
| `MARGINALIA_PDF_CHANNEL` | `chromium-headless-shell` | Playwright channel. Set to `chromium` for a local full-Chrome install; empty to let Playwright pick. |
| `MARGINALIA_PDF_ALLOWED_HOSTS` | (empty) | Comma-separated extra hostnames the export Chromium may reach (on top of the built-in Google Fonts pair). **Every host added here expands the SSRF surface** — a crafted document that references an allowlisted host can make the worker fetch from it. Only `https:` traffic is allowed regardless of what's on this list; cleartext `http:` stays blocked for every host. Prefer narrowly-scoped hostnames (`cdn.example.com`) over wildcards. Does NOT protect against DNS rebinding — if that matters to your deployment, layer post-resolve IP-range checks into `page.route` in `src/export/pdf.ts`. |
| `MARGINALIA_MERMAID_JS_PATH` | (auto) | Absolute path to `mermaid.min.js` if neither the vendored location nor the node_modules fallback works. |
| `PLAYWRIGHT_BROWSERS_PATH` | (default) | Where Playwright finds Chromium. Docker image sets `/ms-playwright`. |

## Why Playwright (condensed decision record)

Three options were weighed. Playwright won on "already a root
devDep, separate `BrowserContext` per export, `page.emulateMedia`
is stable":

| Option | Why not |
|---|---|
| Pure-TS via `pdfkit` / `@react-pdf/renderer` | Doesn't consume HTML+CSS; would need a parallel exporter against the document AST (~2k lines, DOCX-walker-sized), with materially different output from the viewer. |
| Pandoc shell-out | System dependency, indirect theme mapping (`reference.docx`-style), inverts the render pipeline. |
| WeasyPrint | No JavaScript, so mermaid degrades to labeled code-block. CSS coverage is partial (limited Grid). Python runtime adds governance cost. Being evaluated as a sidecar option — see [issue #10](https://github.com/paulwellnerbou/marginalia/issues/10). |
| **Headless Chromium via Playwright** — chosen | Renders exactly what the viewer does (Shiki, mermaid, full CSS). Single engine; well-maintained; already in the root lockfile. Image weight is real (~1 GB) — mitigated by only shipping `chromium-headless-shell` and vendoring mermaid's UMD. |

The architectural direction for a production deployment is to
extract the Chromium work into a sidecar container — see
[issue #10](https://github.com/paulwellnerbou/marginalia/issues/10).
This module's `exportPdf({ body, themeCss, printCss, meta, … }) → Uint8Array`
shape is exactly the HTTP contract a sidecar needs.

See [`src/export/pdf.ts`](./src/export/pdf.ts) for the exporter,
[`src/export/html-envelope.ts`](./src/export/html-envelope.ts) for
the HTML assembly + mermaid vendoring, and
[`src/export/theme-css.ts`](./src/export/theme-css.ts) for the
recursive theme-CSS resolver. Behavior contract lives in
[`test/export-pdf.test.ts`](./test/export-pdf.test.ts).
