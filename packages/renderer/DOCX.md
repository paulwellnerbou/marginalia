# DOCX Export

`exportDocx(source, options)` renders a Marginalia document (Markdown
or AsciiDoc) to a Word `.docx` styled to match a viewer theme —
fonts, heading hierarchy, spacing, tables, blockquotes and code
blocks all carry over. The implementation lives in
[`src/export-docx.ts`](./src/export-docx.ts).

## Request flow

```
apps/web  ──► "Word document" item in the toolbar DownloadMenu
              │ (download icon next to the gear, available to readers)
apps/server ─► GET /api/documents/:uid/export.docx
              │ loads document + theme tokens + attached assets
              ▼
packages/renderer/src/export-docx.ts
              │ 1. run the markdown/asciidoc pipeline up to HAST
              │ 2. pre-resolve images in parallel
              │ 3. extract GFM footnotes
              │ 4. walk HAST → docx.Document (theme-aware styles)
              │ 5. Packer.toBuffer()
              ▼
            .docx file download
```

No changes to the front-end render path — DOCX runs a parallel pipeline
server-side. Theme tokens come from
[`@marginalia/themes/tokens`](../themes/src/tokens.ts); the exporter
consumes only tokens, never CSS.

## Content mapping

| Markdown / HAST | DOCX construct |
|---|---|
| `h1`–`h6` | `Paragraph` with style `Heading1`..`Heading6`, font/size/weight/uppercase from tokens. Wrapped in a `Bookmark` keyed by the heading's slug id. |
| Paragraph | `Paragraph` style `Normal`. |
| `strong`/`em`/`code`/`del` inline | `TextRun` with bold/italic/strike. Inline `code` uses mono font + `codeBg` shading at 0.9 × base size. |
| Code block (Shiki spans) | `Paragraph` style `CodeBlock`, one `TextRun` per Shiki span preserving the per-token color. Shaded background, mono font, `contextualSpacing`. |
| `ul`/`ol` | `Paragraph` with `numbering` referencing the `marginalia-bullet` / `marginalia-ordered` registry. Nested lists use increasing `level` (up to 6). |
| Table (GFM) | `Table` with `TableRow`/`TableCell`. Header row carries the `TableHeader` style + a heavier bottom border when `tokens.table.headerUnderline` is set. Zebra striping (`tokens.table.zebra`) applies to `tbody tr:nth-child(even)` only. |
| Blockquote | `Paragraph` style `Blockquote`, italic runs, left border from `tokens.colors.quoteBar` when `tokens.blockquote.hasBar`. |
| Image | `ImageRun` with bytes resolved via `options.resolveAsset`. `data:` URLs decoded inline. Unsupported mimes (e.g. SVG) and missing resolutions fall back to a muted `[image: alt]` placeholder. Sized to the content-column width unless `width`/`height` attrs are present. |
| External link | `ExternalHyperlink` with accent-colored, underlined runs. |
| Internal link (`[x](#slug)`) | `InternalHyperlink` targeting the matching heading bookmark. Same accent + underline treatment. |
| Heading-anchor sigil (`<a class="heading-anchor">`) | Stripped — UI chrome, not content. |
| TOC | Real Word `TableOfContents` field with `hyperlink:true`, `headingStyleRange:'1-6'`, `beginDirty:true` (so Word prompts to populate on first open). Placement: an explicit `[TOC]` or `[[_TOC_]]` marker in the source wins; otherwise auto-emitted after the leading heading when the doc has ≥ 2 headings. Controlled by `options.includeToc` (`'auto' \| true \| false`). |
| Footnotes (GFM) | Native DOCX footnotes. Refs become `FootnoteReferenceRun`s; bodies land in `word/footnotes.xml` with multi-block content (paragraphs, lists, code, blockquotes) preserved. |
| Mermaid block | **Stopgap:** rendered as a labeled code block. Real SVG → PNG rasterization is deferred; it needs a headless Chromium backend. |
| Horizontal rule | `Paragraph` with a `top` border styled from `tokens.colors.border`. |
| Frontmatter | Skipped in the body. `lang:` / `language:` / `locale:` drives document-wide `<w:lang>` and `<w:bidi/>` for RTL scripts. `options.title` / `options.author` flow to DOCX core properties. |

All named styles (`Heading1`–`Heading6`, `Normal`, `CodeBlock`,
`Blockquote`, `TableHeader`) are registered once per export from the
active theme's tokens, so they also show up in Word's Styles pane —
editable downstream.

## TOC placement markers

Either of these on a line by itself marks the spot where the Word TOC
field is injected:

```md
[TOC]
[[_TOC_]]
```

`[TOC]` is the Python-Markdown / MkDocs / Typora convention;
`[[_TOC_]]` is GitLab Flavored Markdown and Obsidian. Both are
accepted so authors moving between ecosystems keep the same source
working.

Detection runs on the **parsed mdast structure**, not the stringified
text, so the plugin can tell `[[_TOC_]]` (emphasis, a marker) apart
from `[[__TOC__]]` (strong emphasis, literal bolded content in a
document). `mdast-util-to-string` strips both, so relying on
stringified equality would have quietly swallowed any author who
wrote `[[__TOC__]]` as prose. `[[TOC]]` without underscores is also
literal content — it is *not* recognised as a marker.

When multiple markers appear the TOC lands at the **first** one;
later markers are silently dropped. Markers inside code blocks,
blockquotes, or list items are left as literal text — they have to
sit at the top level on a line of their own to count.

Precedence:

1. Explicit `[TOC]` / `[[_TOC_]]` marker → TOC at that position.
2. No marker, `options.includeToc === 'auto'` (default) and the doc
   has ≥ 2 headings → TOC right after the leading heading.
3. `options.includeToc === true` → always emit (with marker
   placement if available, otherwise the heuristic).
4. `options.includeToc === false` → never emit; any markers in the
   source are stripped without creating a TOC.

In the viewer, the marker renders as a small italic pill (`§ Table of
contents`) so the author can see where the TOC will land in the
exported document without having to re-export. The sidebar TOC is
unchanged; the badge is purely positional. It's `aria-hidden` — the
sidebar remains the accessible navigation.

## Edge cases

- **Custom fonts.** DOCX doesn't embed fonts. Each theme ships a
  fallback chain (e.g. `Source Serif 4 → Georgia → serif`). Word
  substitutes when the preferred face isn't installed. The export
  dialog surfaces this as a one-line notice.
- **Shiki colors.** Each highlighted token keeps its Shiki color via
  `TextRun.color`; we don't remap to the theme accent. The Shiki
  background gets the theme `codeBg` as a fallback.
- **Page size & margins.** Come from `tokens.page.size` (A4 / Letter /
  A5 / B5) and `tokens.page.marginPt`. Defaults to A4 with 1" margins.
- **Images / assets.** The server's asset resolver looks up refs by
  name in the per-document blob store. Absolute http(s) URLs are not
  fetched — the server only serves bytes it owns. Shared `src`s are
  resolved once per export.
- **Large documents.** `Packer.toBuffer` is synchronous and in-memory.
  Fine for typical documents; if it becomes an issue, switch to
  `Packer.toStream`.
- **RTL / non-Latin scripts.** `bidi` and the BCP-47 lang tag both
  apply when frontmatter declares an RTL language (`ar`, `he`, `fa`,
  `ur`, `ps`, `ug`, etc.) or when `options.language` forces one.

## Why this approach

Three candidates were weighed before shipping:

| Option | Why not |
|---|---|
| `html-to-docx` (HTML → DOCX) | Limited CSS support, unstable table / list fidelity, hard to map theme tokens cleanly. |
| `pandoc` shell-out | System dependency, inverts the render pipeline, theme mapping is indirect (`reference.docx`). |
| **`docx` npm package (programmatic)** — chosen | Full control, proper named Word styles, deterministic output, native per-token Shiki colors. Cost is owning a HAST walker. |

The walker consumes the same HAST tree the viewer stringifies to HTML,
so Shiki highlighting, heading anchors, and block IDs all come for
free. See [`src/export-docx.ts`](./src/export-docx.ts) for the
implementation and [`test/export-docx.test.ts`](./test/export-docx.test.ts)
for the behavior contract.
