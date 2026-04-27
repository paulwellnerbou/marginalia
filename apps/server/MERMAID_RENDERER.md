# Mermaid renderer — plan & implementation notes

Companion to [`PDF_EXPORT.md`](./PDF_EXPORT.md) and
[`packages/renderer/DOCX.md`](../../packages/renderer/DOCX.md).

This document tracks the next phase of mermaid-rendering work for
DOCX and PDF exports. PR #21 shipped an in-process Rust renderer
(`mmdr`) for DOCX; this plan adds a high-fidelity Chromium renderer
behind a per-document switch and unifies the path through both
exporters.

Updates [issue #10](https://github.com/paulwellnerbou/marginalia/issues/10).

## Status (after PR #21)

- DOCX rasterizes mermaid via `mmdr` (~10–20 ms per diagram, no
  browser). Output is "different but not wrong" — usable for most
  diagrams but visibly off for some flowcharts.
- PDF still uses live Chromium + the inlined mermaid UMD; identical
  to the viewer.
- No way to opt into Chromium-quality mermaid for DOCX, or to skip
  the Chromium mermaid runtime for PDF.

## Goal

Per-document switch between two renderers, applied uniformly to
**both** DOCX and PDF:

| Renderer | Engine | Cost | Fidelity |
|---|---|---|---|
| `mmdr` (default) | Native Rust subprocess | ~20 ms / diagram, no browser | "different but not wrong" — fails on some diagrams |
| `chromium` | Headless Chromium running real mermaid.js | ~1–2 s / diagram, full browser | Pixel-identical to the viewer |

Authors pick `chromium` for documents where mmdr regresses; everyone
else gets the fast path by default.

## Locked-in design decisions

These were resolved up-front; record them so we don't relitigate
mid-implementation.

1. **No per-block override.** The switch is document-level only.
   No ` ```mermaid renderer=chromium ` syntax, no per-diagram UI.
2. **SVG for PDF, PNG for DOCX.** Both renderers natively produce
   both formats; the consumer picks which one it ingests:
    - **PDF body** inlines `<svg>…</svg>` directly. Chromium prints
      vector → vector PDF, so diagrams stay sharp at any zoom and
      file size shrinks for diagram-heavy docs.
    - **DOCX** stays PNG-only. Word's SVG support requires shipping
      a PNG fallback in the same picture element (older Word
      ignores the SVG part), which doubles per-diagram cost and the
      embed path complexity for negligible benefit. Re-evaluate if
      anyone asks.
3. **No caching in v1.** A per-export re-render is acceptable.
   Cache (content-addressed by `(source, theme, renderer-version)`)
   is a Phase C follow-up if it becomes a bottleneck.
4. **Settings UI calls out the export-only scope.** "Affects PDF
   and Word downloads only — the viewer always uses mermaid.js."
   Authors shouldn't have to wonder whether changing the setting
   changes what they see in the browser.

## Architecture

The renderer choice happens **before** the format-specific exporters.
By the time bytes reach `exportDocx` / `exportPdf`, every mermaid
block is either already rasterized (image bytes ready to embed) or
still inline as `<div class="mermaid">` (the `chromium` PDF path
still uses the in-page mermaid runtime, identical to today).

```
                     ┌─────────────────────┐
   document source  →│  resolve mermaid    │
   + renderer choice │  blocks → image     │
                     └────────┬────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
       ┌────────────────┐          ┌─────────────────────────┐
       │  exportDocx    │          │  exportPdf               │
       │  (embed PNG    │          │  (inline SVG into body  │
       │   via ImageRun)│          │   OR live mermaid divs  │
       │                │          │   for chromium path)    │
       └────────────────┘          └─────────────────────────┘
```

### Two resolver implementations behind the same callback

```ts
type MermaidResolver = (
  source: string,
  index: number,
  format: 'svg' | 'png',
) => Promise<ResolvedAsset | null>;

renderMermaidWithMmdr     : MermaidResolver  // existing, in apps/server/src/export/mermaid-rust.ts
renderMermaidWithChromium : MermaidResolver  // NEW, reuses the PDF browser singleton
```

The Chromium resolver opens a `BrowserContext` from the existing PDF
singleton (`getBrowser()` in `pdf.ts`), navigates to a minimal HTML
page that loads the inlined mermaid UMD, calls
`mermaid.render(id, source)` to get an SVG, then either returns the
SVG bytes (`format: 'svg'`) or screenshots the rendered SVG element
to PNG (`format: 'png'`).

`mmdr` passes `--format svg` or `--format png` to the CLI.

A small router picks the resolver per request:

```ts
function pickMermaidResolver(choice: 'mmdr' | 'chromium'): MermaidResolver {
  return choice === 'chromium' ? renderMermaidWithChromium : renderMermaidWithMmdr;
}
```

### PDF flow change

Today PDF passes `<div class="mermaid">` blocks straight through and
lets the in-page mermaid runtime render them. That stays as the
`chromium` path.

For the `mmdr` path, **pre-rasterize before** building the HTML
envelope: walk the rendered HTML, replace each mermaid div with the
SVG returned by `mmdr`, then call `exportPdf` with
`hasMermaid: false`. Result:

- PDF Chromium never loads the mermaid UMD (~3 MB saved per export).
- No `__marginaliaMermaidReady` wait → faster end-to-end.
- Vector SVG in vector PDF — sharp at any zoom.

This pre-rasterization step is shared with DOCX (DOCX requests PNG
instead of SVG). It lives next to the exporters, not inside either
of them, so the renderer-choice surface stays uniform.

### DOCX flow change

`resolveMermaid` becomes a one-line dispatch in the route handler.
No change to the `exportDocx` API surface beyond accepting the
`format` parameter on the existing callback (or keeping `'png'`
implicit there since DOCX always wants PNG).

```ts
// apps/server/src/routes/documents.ts (DOCX route, sketch)
const choice = effectiveMermaidRenderer(doc, query, config);
const resolver = pickMermaidResolver(choice);
const buf = await exportDocx(source, {
  ...,
  resolveMermaid: (src, idx) => resolver(src, idx, 'png'),
});
```

## Data model

Add one column to `documents`:

```sql
ALTER TABLE documents ADD COLUMN mermaid_renderer TEXT;
-- nullable; NULL = use server default
-- valid values: 'mmdr', 'chromium'
```

Server-wide default via env var:

```
MARGINALIA_MERMAID_RENDERER_DEFAULT=mmdr   # or 'chromium'; default 'mmdr'
```

Resolution order for an export request:

1. Explicit query param (`?mermaid=chromium` — for ad-hoc previews
   without changing the document setting). Optional, mostly for
   debugging.
2. Document property (`mermaid_renderer` column).
3. Server default (env var).
4. Hard-coded `'mmdr'` if all else is unset.

## Settings API

Extend the existing `PATCH /api/documents/:uid/settings` to accept
`mermaid_renderer`:

```http
PATCH /api/documents/:uid/settings
{ "mermaid_renderer": "chromium" }    # or "mmdr" or null (clear → use default)
```

Validate it's one of `mmdr`, `chromium`, or null; reject anything
else with 400 — same shape as the existing theme validation.

## UI

Document settings panel (next to the theme picker) gets a small
select:

```
Mermaid renderer:  ( ) Default  (•) Fast (mmdr)  ( ) High-fidelity (Chromium)

  Affects PDF and Word downloads only — the viewer always uses
  mermaid.js. "Default" follows the server setting (currently:
  Fast).
```

Surface the current effective renderer in the export download
buttons too — a one-line "Rendering diagrams with: chromium
(slower, full quality)" appears in the export-confirm UI when the
choice differs from the default. Stops the user from being
surprised by a multi-second export delay on a doc with many
diagrams.

## Sidecar (issue #10 Phase 1) — deferred

The original Phase 1 motivation (Chromium out of the main image,
blast-radius isolation, lifecycle independence) is **independent**
of the renderer-switch work. We can:

1. Ship the switch with both resolvers running in-process. No new
   container, no docker-compose changes. Image size is unchanged
   because Chromium is already there for PDF.
2. Later, file a follow-up that extracts both `chromium` mermaid +
   PDF into the sidecar from issue #10's Phase 1 spec. The
   renderer-choice surface (data model, route, UI) doesn't change
   — only the implementation behind `renderMermaidWithChromium`
   switches from "in-process Browser" to "HTTP POST to
   render-worker".

This split lets us close the immediate fidelity problem without
taking on the operational change.

## Phasing

### Phase A — renderer dispatch (in-process Chromium)

In execution order:

1. **DB migration**: `mermaid_renderer` column on `documents`.
2. **Settings API**: extend `PATCH /:uid/settings` with validation;
   extend `GET /:uid` payload to include the value.
3. **Resolver shape**: extend the existing `resolveMermaid`
   callback signature with the `format` parameter; teach `mmdr`
   wrapper to accept either format.
4. **Chromium resolver**: new module
   `apps/server/src/export/mermaid-chromium.ts`. Reuses the PDF
   browser singleton. Same typed-error shape as `mermaid-rust.ts`
   (engine-missing / render-error / timeout).
5. **Pre-rasterization helper**: shared HTML-walk-and-replace used
   by the PDF route (replace `<div class="mermaid">` with
   `<svg>…</svg>` from the resolver). Lives next to the exporters.
6. **Route wiring**: DOCX + PDF route handlers read effective
   choice and pick the resolver. `?mermaid=` query override
   honoured.
7. **UI**: document settings panel gets the renderer select with
   the export-only-scope copy. Export-confirm dialog shows the
   current effective renderer when it differs from the default.
8. **Tests**: cross-product matrix —
   DOCX × {mmdr, chromium}, PDF × {mmdr, chromium}. The mmdr+PDF
   combo is the new shape and gets explicit coverage that the
   rendered HTML has no live `<div class="mermaid">` left.

### Phase B — sidecar extraction (issue #10 Phase 1, unchanged)

Filed as a separate ticket. The renderer-switch surface from
Phase A doesn't change; only the implementation behind
`renderMermaidWithChromium` (and `exportPdf`) swaps in an HTTP
client to the new render-worker.

### Phase C — caching (optional follow-up)

Content-addressed cache keyed by `(source, theme, renderer-version)`.
Skip until a real document with many diagrams demonstrates the
need.

## Non-goals

- Per-block renderer override. Decided up-front.
- DOCX SVG support. Word fallback complexity isn't justified.
- Cross-export caching. Phase C only.
- Changing the viewer's renderer. The viewer always uses mermaid.js
  (client-side); this work only affects export.
