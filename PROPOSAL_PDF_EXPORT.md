# Technical Proposal — PDF Export

Scope: implement the PDF half of [PLAN.md §7a](PLAN.md) and the PDF half of
[REQUIREMENTS.md §3.8](REQUIREMENTS.md). DOCX already shipped in
[packages/renderer/src/export-docx.ts](packages/renderer/src/export-docx.ts)
(see [DOCX.md](packages/renderer/DOCX.md)) — PDF follows its shape where
sensible but lives elsewhere (see §4).

> **Revised 2026-04-21** after a 39-commit merge from main that shipped
> DOCX, the `DownloadMenu`, title/filename helpers, theme tokens, and the
> `[TOC]` marker plugin. Earlier draft pointed the UI hook at
> `DocumentSettingsDialog` and proposed a renderer-side `mermaid: 'svg'`
> mode; both are retracted below.

## 1. Goal

A viewer of a document (any role that can read it) can export the current
document as a `.pdf` that is visually faithful to the on-screen rendering
under the currently selected theme, with all content rendered server-side.

Success criteria:

- `GET /api/documents/:uid/export.pdf?theme=<name>` returns a valid PDF.
- Mermaid diagrams, Shiki-highlighted code, images (including blob-store
  assets), footnotes, and GFM tables all render correctly.
- Filenames match the DOCX download — same `extractDocumentTitle` /
  `sanitizeDocumentFilename` helpers.
- A 50-page document exports in < 5 s on the dev box (target, not SLA).

CLI support (`marginalia export … --format=pdf`) is **deferred** — the
server endpoint covers the stated user need, and bundling Playwright into
the CLI is a separate weight call.

## 2. Requirements recap

From [REQUIREMENTS.md §3.8](REQUIREMENTS.md):

- Uses the currently selected theme for styling.
- Renders server-side.
- Mermaid must be static (SVG). Shiki is already static.

The DOCX exporter handles mermaid as a "stopgap labeled code block"
(see [DOCX.md §Content mapping](packages/renderer/DOCX.md)). PDF has the
advantage of shipping the render engine (Chromium), so mermaid lands as
real SVG in v1 — without needing a renderer-side change (see §3.4).

## 3. Decisions

### 3.1 Headless engine — **Playwright (already a dep)**

`playwright@^1.59.1` is already in the root `package.json` as a
devDependency (presumably for e2e). We promote it into
`apps/server/package.json` as a runtime dependency. The Chromium binary
is fetched via `bunx playwright install chromium` in the Dockerfile and
in the dev-setup instructions.

Puppeteer was the alternative; Playwright wins because it's already here,
has a cleaner `BrowserContext` story for concurrent exports, and
`page.emulateMedia({ media: 'print' })` is stable.

### 3.2 Process model — **one long-lived browser, per-export context**

Chromium launch is ~300 ms; a fresh `BrowserContext` is ~5 ms. Start
lazily on the first export, keep alive for the life of the server, tear
down on `SIGTERM`. Each export gets a fresh context+page so state cannot
leak across documents. A semaphore caps concurrent exports (default 2).

### 3.3 Sync vs async response — **sync, hard 30 s timeout**

v1 is a blocking `GET` that streams the PDF back as `application/pdf`.
No job queue, no polling. If a production load ever warrants it, a queue
can be retrofitted without breaking the URL.

### 3.4 Mermaid rendering — **client-side inside the export Chromium page**

The earlier draft proposed implementing `mermaid: 'svg'` in the renderer
([packages/renderer/src/plugins/mermaid.ts:16](packages/renderer/src/plugins/mermaid.ts)).
Retracted: we'd be reinventing what Chromium already does. Instead:

- Renderer keeps `mermaid: 'client'` mode (its default and only working
  mode).
- The PDF exporter's HTML envelope **inlines the vendored mermaid UMD
  bundle** (`mermaid.min.js`, ~3 MB, read via `loadMermaidUmd()`) and
  initialises it from a second inline `<script>` that calls
  `mermaid.run()`. No external JS fetch happens during export — the
  outbound-request firewall would block it anyway (see §7).
- After `page.setContent(html)`, the exporter awaits a sentinel (a
  `window.__marginaliaMermaidReady` promise the inline script resolves)
  before calling `page.pdf()`.

This leaves the DOCX "labeled code block" stopgap untouched. If we later
decide DOCX should embed real SVGs, the natural path is to factor out a
`renderMermaidBlocks(sources) → svg[]` helper against the same browser
instance and have the DOCX route call it before `exportDocx()`. Flagged
in §8, not v1.

### 3.5 Theme selection — **server reads `packages/themes/css/<name>.css`**

`?theme=<name>` wins; otherwise fall back to `doc.default_theme`; unknown
names fall back to `default`. Matches the DOCX route's resolution
([apps/server/src/routes/documents.ts:476](apps/server/src/routes/documents.ts:476)).
The theme CSS file is read at export time and inlined into the exported
HTML document.

### 3.6 Print stylesheet — **new `packages/themes/css/_print.css`**

A single print-only layer, always appended after the selected theme,
setting: `@page` size + margins, page-break rules for headings / tables /
code blocks / mermaid, widow/orphan control, and `display: none` for
interactive UI (comment gutters, block actions, heading-anchor sigils,
the `.marginalia-toc-marker` pill from
[toc-marker.ts:42](packages/renderer/src/plugins/toc-marker.ts:42)).
Lives in the themes package so theme authors can override selectors.

### 3.7 Page metadata — **title + author from core properties**

`Title` from `doc.name || extractDocumentTitle(source, format)`; `Author`
from the caller's `displayName`; `CreationDate` = now. Passed to
`page.pdf({ ... })` where supported, and also set via `<meta>` tags in
the HTML head as a fallback.

### 3.8 Auth — **same rule as `export.docx`**

Load via `loadDoc`, gate via `authorizeRequest`. Identical to
[exportDocumentAsDocx](apps/server/src/routes/documents.ts:467). If a
viewer can read the doc, they can export it.

## 4. Architecture

```
Client UI (DownloadMenu) ────► GET /api/documents/:uid/export.pdf?theme=<name>
                                       │
                                       ▼
                    apps/server/src/routes/documents.ts
                                       │ authorizeRequest()
                                       │ loadDoc + listAttached
                                       │ renderDocument(source, { mermaid: 'client' })
                                       │ read theme CSS + _print.css
                                       ▼
                    apps/server/src/export/pdf.ts
                          exportPdf({ html, themeCss, printCss, meta, signal })
                                       │ get or lazy-init shared Browser
                                       │ semaphore.acquire()
                                       │ browser.newContext() + newPage()
                                       │ page.setContent(assembledHtml, { waitUntil: 'networkidle' })
                                       │ page.waitForFunction('__marginaliaMermaidReady')
                                       │ page.emulateMedia({ media: 'print' })
                                       │ page.pdf({ format: 'A4', printBackground: true })
                                       ▼
                              Uint8Array<ArrayBuffer>
                                       │
                                       ▼
                    Response: application/pdf
                              Content-Disposition: attachment; filename="<slug>.pdf"
                              Cache-Control: private, no-store
                              X-Content-Type-Options: nosniff
```

### Why the exporter lives in `apps/server/`, not `packages/renderer/`

DOCX lives in the renderer because it's a pure function of source + theme
tokens — the renderer can own it without pulling heavy dependencies.

PDF is different: it requires a live Chromium process. Putting Playwright
in `packages/renderer` would pin that dependency on every consumer of the
renderer (CLI, embed element, server). The renderer stays light; the
server owns the browser lifecycle.

The two exporters share: theme resolution (by name), asset resolution
(`listAttached` → map ref → bytes), the `extractDocumentTitle` /
`sanitizeDocumentFilename` helpers, and the download-filename convention.

## 5. Concrete changes

> Updated post-implementation to match what actually shipped.

| File | Change |
|------|--------|
| [apps/server/package.json](apps/server/package.json) | Add `playwright`, `mermaid`, and `@marginalia/themes` to `dependencies`. |
| **new** `apps/server/src/export/pdf.ts` | `exportPdf()`, shared `Browser` lifecycle + semaphore (with generation token), 30 s timeout, outbound-request firewall, typed error classes. |
| **new** `apps/server/src/export/html-envelope.ts` | `buildExportHtml()`, `inlineImageAssets()`, and `loadMermaidUmd()` (resolves vendored file → `import.meta.resolve` node_modules fallback). Mermaid bootstrap lives here as an inline template, not a separate file. |
| **new** `apps/server/src/export/theme-css.ts` | `loadThemeCss()` + `loadPrintCss()` with recursive local-`@import` inlining. |
| [apps/server/src/routes/documents.ts:64](apps/server/src/routes/documents.ts:64) | Register `r.get('/:uid/export.pdf', …)` beside the `.docx` route. New handler `exportDocumentAsPdf()` copies the DOCX handler's auth + load + theme + filename flow. |
| [apps/server/src/app.ts](apps/server/src/app.ts) | `App.close()` becomes async and awaits `closeExportBrowser()`. Tests updated to await teardown. (No `apps/server/src/main.ts` change — the process exits on SIGTERM, which kills the Chromium child.) |
| **new** `packages/themes/css/_print.css` | Print-only stylesheet (see §3.6). |
| [packages/themes/package.json](packages/themes/package.json) | Export `_print.css` under the `./_print.css` subpath. |
| [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts) | Add `downloadDocumentPdf(uid, theme)` mirroring `downloadDocumentDocx`. |
| [apps/web/src/components/DownloadMenu.tsx](apps/web/src/components/DownloadMenu.tsx) | Add a third `DropdownMenu.Item` for "PDF document (.pdf)" with typed toasts for `export-engine-missing` / `busy` / `timeout`. |
| **new** `apps/server/test/export-pdf.test.ts` | 11 integration tests (headers, filename derivation, 404/401, theme respect, asset inlining + alt-text collision regression, mermaid rendering, path-traversal rejection, SSRF firewall). |
| [Dockerfile](Dockerfile) | Installs `chromium-headless-shell` (not full Chrome); production-only `bun install` in the runner; vendors `mermaid.min.js` and drops the mermaid package + its transitive graph from the runtime. Final image ~1.29 GB. |

## 6. Data flow details

### 6.1 Asset resolution

Blob-store images are **inlined as `data:` URLs** in the HTML envelope
before `page.setContent()`. Same pattern as the DOCX exporter's
`resolveAsset` callback, except we produce data URLs instead of
`ImageRun` bytes. The export page has no network access (Chromium
`--disable-features=NetworkService` is overkill — we just don't fetch
anything that isn't in the envelope, because all attached assets are
already inlined and the mermaid CDN is the only outbound fetch).

Deciding about the mermaid CDN: **vendor the mermaid UMD bundle into the
server's static assets** (`apps/server/src/export/assets/mermaid.min.js`)
and inline it. Zero runtime network dependency. Adds ~3 MB to the
server's on-disk footprint. Worth it for reproducibility and to keep
exports working offline.

### 6.2 Comments

Not printed in v1. The print stylesheet hides the gutter and markers.
A future `?comments=inline|appendix` flag can render them.

### 6.3 TOC

The renderer's `[TOC]` / `[[_TOC_]]` marker ([toc-marker.ts](packages/renderer/src/plugins/toc-marker.ts))
emits `<div class="marginalia-toc-marker">` — hidden in print. The
viewer's actual TOC lives in a sidebar, which is also hidden in print.
For v1 the PDF has **no auto-generated TOC**. Heading anchors are
clickable internal links (they already exist in the rendered HTML).

If users want a printed TOC, follow-up work would either (a) emit a real
TOC block at the marker position (analogous to DOCX's TOC field), or (b)
use `page.pdf({ outline: true })` for a PDF-level outline. Noted, not v1.

### 6.4 Shutdown

The Bun process is typically killed with SIGTERM in production; Chromium
children die with it. The explicit `closeExportBrowser()` hook in
`main.ts` is a courtesy for tests and local `bun --hot` reloads, which
otherwise leak Chromium processes on every change.

## 7. Security

- Auth: same path as the DOCX export — `authorizeRequest` at the route
  boundary.
- Content: the renderer output is already sanitized via `rehype-sanitize`
  ([render.ts:86](packages/renderer/src/render.ts:86)). The exporter
  appends no untrusted HTML of its own.
- Network: the export page is fed HTML with all assets inlined and no
  external `<script src>` / `<link href>` — the vendored mermaid script
  is the only script, inline. A Chromium with default sandboxing is fine.
- File paths: the theme CSS path is constructed from a static directory
  + an allow-listed theme name (mirror the DOCX exporter's fallback to
  `default`). No traversal surface.

## 8. Failure modes

| Case | Behavior |
|------|----------|
| Chromium not installed | Handler returns 500 `{ error: 'export-engine-missing', hint: 'run `bunx playwright install chromium`' }`. UI shows a toast with the hint. |
| Export timeout (> 30 s) | Abort the page, respond 504, log `uid` + elapsed. |
| Semaphore full | 503 with `Retry-After: 2`. UI retries once automatically. |
| Mermaid parse error in one block | The client-side mermaid renders an inline error card in place of that diagram. Export still succeeds. |
| Very large doc (> 200 pages) | No special handling v1. Timeout is the signal. |
| Browser crash | `exportPdf` catches, recycles the browser, returns 500. Next request re-launches. |

## 9. Follow-ups (explicitly out of v1 scope)

- **CLI `marginalia export … --format=pdf`** — requires either bundling
  Playwright into the CLI (~170 MB) or shelling out to a local server.
  Separate design discussion.
- **DOCX mermaid SVG embedding** — factor out a `renderMermaidBlocks()`
  helper against the same shared browser; DOCX route pre-rasterizes
  mermaid blocks to SVG and passes them to `exportDocx` via a new
  `resolveMermaid` option.
- **PDF-native outline / TOC** — `page.pdf({ outline: true })` plus a
  printed TOC at the `[TOC]` marker position.
- **Cover page** — optional, trivial via a header partial in the HTML
  envelope.
- **Non-A4 page sizes** — add `?size=letter|a5|a4` and read from
  `tokens.page.size` if the theme has it (DOCX already does this).

## 10. Phasing

1. **Print stylesheet** + theme package export. (~0.5 d)
2. **`exportPdf()` module**: browser lifecycle, HTML envelope, vendored
   mermaid, sentinel wait. Tested with a hand-written fixture first,
   then against `renderDocument()` output. (~1 d)
3. **Server route**: `GET /:uid/export.pdf`, mirror DOCX route auth /
   asset / filename pattern. (~0.5 d)
4. **Frontend**: `api.ts` helper + third `DownloadMenu` item. (~0.25 d)
5. **Tests + docs**. (~0.5 d)

Total: **~2.75 days**, inside PLAN §7a's 2–3 day envelope for the PDF
half. DOCX already shipped, so that half is done.

## 11. Open questions

- **Q1**: Vendor mermaid vs. CDN? Proposal: vendor. ~3 MB disk, zero
  runtime network, offline-safe. Confirm before merging.
- **Q2**: Ship `_print.css` as a single shared file, or per-theme print
  overrides? Proposal: one shared file + per-theme CSS can override any
  selector it wants. Matches how `serif-print.css` is structured today.
- **Q3**: Docker image size. Adding Chromium + its system deps
  (`libnss3`, `libatk1.0-0`, libgbm, …) is ~250 MB. The Dockerfile will
  grow. Acceptable, but flag in the PR.
- **Q4**: Should the DownloadMenu PDF item be guarded if Chromium isn't
  installed on the server? Proposal: no — discover on first click, show
  the toast with install instructions. Keeps the UI simple.
