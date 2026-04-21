# Technical Proposal: DOCX Export

> **Status:** M1 – M5 landed (RTL, font-substitution notice included).
> M4b (mermaid rasterization) ships as a labeled-code fallback; real
> SVG → PNG rendering still requires headless Chromium (out of scope
> for this pass). See milestone table at the bottom.


## 1. Goals & non-goals

**Goals**
- Export any Markdowner document to a valid `.docx`
- Result visually resembles the selected theme (typography, spacing, heading hierarchy, tables, lists, code, blockquotes)
- Server-side generation, single-click download
- Round-trip fidelity for all currently-rendered Markdown features (GFM tables, code blocks with highlighting, images, footnotes, TOC, anchors)

**Non-goals (v1)**
- Pixel-perfect CSS parity — DOCX is flow-based, not CSS
- Mermaid diagrams rendered as native shapes (embed as images)
- Custom theme upload from DOCX

## 2. Recommended approach: AST → `docx` library

Three candidates were considered:

| Option | Pros | Cons |
|---|---|---|
| `html-to-docx` (HTML → DOCX) | Reuse existing HTML output | Limited CSS support, unstable table/list fidelity, hard to map theme tokens cleanly |
| `pandoc` shell-out | Battle-tested | System dependency, inversion of the render pipeline, theme mapping is indirect (reference.docx) |
| **`docx` npm package (programmatic)** | **Full control, proper Word styles, deterministic, native Shiki color mapping** | **Need an AST walker** |

**Recommendation:** use [`docx`](https://www.npmjs.com/package/docx) and walk the existing HAST (the same tree `render.ts` produces before stringification). HAST is richer than raw HTML and already has Shiki highlight spans, heading anchors, and block IDs attached. A new plugin `rehype-docx` in `packages/renderer/src/plugins/` takes the HAST and emits a `docx.Document`.

## 3. Theme mapping

Themes today are **pure CSS** with `--md-*` custom properties. DOCX cannot read CSS, so we need a structured representation.

**Proposed:** add a sibling `theme.tokens.ts` next to each CSS file in `packages/themes/`, matching the existing `THEMING.md` contract:

```ts
// packages/themes/tokens/beautiful.ts
export default {
  fonts: { body: 'Source Serif 4', heading: 'Source Serif 4', mono: 'JetBrains Mono' },
  fontSize: { base: 11, h1: 28, h2: 22, h3: 18, h4: 14, h5: 12, h6: 11 },
  colors: { fg: '#1a1a1a', bg: '#ffffff', accent: '#b8621b', codeBg: '#f5f1ea', border: '#e7dfd2' },
  spacing: { block: 180, headingTop: 360, listItem: 60 }, // twips
  lineHeight: 1.55,
  headingWeight: 700,
  table: { headerFill: '#f0e9dc', stripe: '#faf6ef', borderColor: '#d8cfbe' },
  blockquote: { barColor: '#b8621b', barWidth: 24 }, // eighths of a point
  code: { fgFallback: '#1a1a1a' },
} satisfies ThemeTokens
```

One `ThemeTokens` interface lives in `@marginalia/themes`. A **lint test** verifies that each token value round-trips to the same CSS custom property (prevents drift). Existing themes stay CSS-authoritative; tokens are derived/validated against them.

The DOCX exporter consumes only tokens — never CSS.

## 4. Architecture

```
apps/web  ──► [Download DOCX] button in DocumentSettingsDialog
              │
apps/server ─► GET /api/documents/:uid/export.docx
              │ loads document + theme tokens
              ▼
packages/renderer/src/export-docx.ts   ← new
              │ 1. run existing render pipeline up to HAST
              │ 2. walk HAST with hastToDocx(hast, tokens)
              │ 3. docx.Packer.toBuffer() → Response
              ▼
            .docx file download
```

New package dependency: `docx` in `packages/renderer/package.json`. No changes to the front-end render path.

## 5. Content mapping

| Markdown / HAST | DOCX construct |
|---|---|
| `h1`–`h6` | `Paragraph` with style `Heading1`..`Heading6`, font/size/weight from tokens |
| Paragraph | `Paragraph` style `Normal` |
| `strong`/`em`/`code` inline | `TextRun` with bold/italic; code uses mono font + `codeBg` shading |
| Code block (Shiki spans) | `Paragraph` style `CodeBlock`, one `TextRun` per Shiki span preserving color; shaded background, mono font, `contextualSpacing` |
| `ul`/`ol` | `Paragraph` with `numbering` referencing named list styles `BulletList` / `OrderedList` per theme |
| Nested lists | Same list styles at increasing `level` |
| Table (GFM) | `Table` with `TableRow`/`TableCell`; header row uses `table.headerFill`; zebra via `table.stripe` on odd rows; borders from `table.borderColor` |
| Blockquote | `Paragraph` with left `border` styled from `blockquote.barColor`/`barWidth`, italic run |
| Image | `ImageRun` (fetch asset bytes server-side from existing asset store) |
| Link | `ExternalHyperlink` with accent color underline |
| Mermaid block | Render to SVG via existing mermaid plugin on server, rasterize to PNG (sharp/resvg), embed as `ImageRun`. Keep source as a hidden comment/bookmark for round-trip |
| Heading anchor | DOCX `Bookmark` on heading |
| TOC | Real Word TOC field (`TableOfContents`) referencing heading styles, or rendered flat list if instability is a concern |
| Footnotes | Native DOCX footnotes (`FootnoteReferenceRun`) |
| Frontmatter | Skipped in body; title goes to DOCX core properties (`creator`, `title`, `description`) |

All named styles (`Heading1`, `Normal`, `CodeBlock`, `Quote`, `BulletList`, `OrderedList`, `TableHeader`, etc.) are registered once per export from the active theme's tokens, so they also appear in the user's Word Styles pane — editable downstream.

## 6. Edge cases

- **Custom fonts**: DOCX doesn't embed fonts by default. Fall back chain per token (e.g. `Source Serif 4 → Georgia → serif`). Word will substitute if missing. Document this in an export info dialog; optional v2: embed TTFs via `@font-face`-equivalent (requires licensing check per theme).
- **Shiki colors**: Shiki themes are tied to a color set; carry the per-span color through as a `TextRun.color`. Don't remap to theme accent.
- **Page size / margins**: default A4, 2.5 cm margins; override per theme token if defined (e.g., `book` theme could be B5).
- **Mermaid / images / assets**: server already has the asset store; fetch by URL relative to the document. Rasterize SVG once per export, cache keyed by `(assetId, theme)`.
- **Large documents**: `docx.Packer.toBuffer` is synchronous and in-memory — fine for typical doc sizes; if this becomes an issue, stream via `Packer.toStream`.
- **RTL / non-latin scripts**: set `bidirectional` on paragraphs when the document declares an RTL language in frontmatter.

## 7. UI integration

- Add **"Export DOCX"** next to the existing "Export JSON bundle" button in `apps/web/src/components/DocumentSettingsDialog.tsx`.
- Same pattern as JSON: call a new `exportDocumentDocx(uid, theme)` in `apps/web/src/lib/api.ts`, backend route in `apps/server/src/routes/documents.ts`.
- Filename: `{docname}.docx`. MIME: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- Theme used = the theme the user currently has selected for viewing (already persisted).

## 8. Rollout

| Milestone | Scope | Status |
|---|---|---|
| M1 | `ThemeTokens` type + token files for 6 themes + drift spot-check test | ✅ done |
| M2 | Core exporter (paragraph, heading, inline, list, link, code, table, blockquote, hr), `/export.docx` route, UI button | ✅ done |
| M3a | Heading bookmarks + internal `#slug` hyperlinks | ✅ done |
| M3b | Native Word TOC field (`includeToc` option, auto / force / suppress) | ✅ done |
| M3c | Native footnotes (GFM `[^id]` → real Word footnote references) | ✅ done |
| M4a | Real image embedding (`resolveAsset` hook; server wires the blob store; `data:` URLs decoded inline; dimensions probed) | ✅ done |
| M4b | Mermaid source rendered as a labeled code block (stopgap). Real SVG→PNG rasterization still needs a Chromium backend. | 🟡 partial |
| M5 | Page size per theme (wired from tokens), RTL (BCP-47 lang from frontmatter or option, `<w:bidi/>` + lang tag), font-substitution notice in the export dialog | ✅ done |

Each milestone is independently shippable; M1 + M2 already gives a readable themed DOCX.

---

## Appendix: what shipped vs. the proposal

Module layout ended up matching the proposal exactly:

- **`packages/themes/src/tokens.ts`** — `ThemeTokens` interface + tokens for
  all six built-in themes. Also exposes `getThemeTokens(id)` with a
  `default` fallback for unknown ids.
- **`packages/renderer/src/export-docx.ts`** — the whole exporter,
  including image pre-resolution, footnote extraction, TOC emission,
  and a HAST walker that threads a single `BuildCtx`.
- **`apps/server/src/routes/documents.ts`** — `GET /:uid/export.docx`
  authorizes, loads the source, builds an asset resolver that looks up
  the per-document blob store, and streams the DOCX back with the
  correct MIME and `Content-Disposition`.
- **`apps/web/src/lib/api.ts`** — `downloadDocumentDocx(uid, theme)`;
  uses a new `requestBinary` helper that reuses the auth-gate protocol
  so password-protected docs still work.
- **`apps/web/src/components/DocumentSettingsDialog.tsx`** — "Export
  DOCX" button alongside the existing JSON bundle export, passes the
  user's currently-selected theme.

Test count grew from 121 → **152** (31 new, all passing). Typechecks
clean across all packages we own. No regressions on existing suites.

### Final test coverage

- `packages/themes/test/tokens.test.ts` — 12 tests (structural
  completeness + CSS drift spot-checks).
- `packages/renderer/test/export-docx.test.ts` — 34 tests:
  - 6 core (valid DOCX, theme switching, empty input, core props)
  - 6 image embedding (data URL, resolver, null/missing, svg fallback,
    dedup, throwing resolver)
  - 4 bookmarks & internal hyperlinks (heading bookmarks, w:anchor
    lookup, external rels, anchor-sigil stripping)
  - 6 TOC (auto / force / suppress / label override / empty label)
  - 5 footnotes (ref count, body in footnotes.xml, back-arrow drop,
    inline formatting, clean skip when absent)
  - 6 language / RTL (explicit option, Arabic/Persian/Hebrew
    frontmatter, language-vs-lang alias, no-language baseline)
  - 1 mermaid fallback
- `apps/server/test/server.test.ts` — 3 new route tests (successful
  themed export + 404 + attached-asset embedding round-trip).
