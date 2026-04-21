# Theming Contract

Marginalia themes are pure CSS. Switching themes swaps one stylesheet; the
HTML produced by `@marginalia/renderer` does not change.

## Root class

Every rendered document is wrapped in `<article class="marginalia">…</article>`
by the CLI and the viewer. All selectors should be scoped under `.marginalia`
so embedding into a host page doesn't leak styles.

## Tunable CSS variables

Themes express their configurable values as CSS custom properties on
`.marginalia`. A theme editor may override any of these at runtime without
re-rendering the document.

| Variable | Purpose |
|---|---|
| `--md-max-width` | Reading column width |
| `--md-font-body` | Body font stack |
| `--md-font-heading` | Heading font stack |
| `--md-font-mono` | Monospace font stack |
| `--md-font-size` | Base body font size |
| `--md-line-height` | Body line-height |
| `--md-heading-line-height` | Heading line-height |
| `--md-heading-weight` | Heading font weight |
| `--md-heading-letter-spacing` | Heading tracking |
| `--md-space-block` | Gap between top-level blocks |
| `--md-space-heading-top` | Extra space above headings |
| `--md-space-list-item` | Gap between list items |
| `--md-color-fg` | Body text color |
| `--md-color-fg-muted` | Secondary text (captions, quotes, muted UI) |
| `--md-color-bg` | Page background |
| `--md-color-accent` | Link / accent color |
| `--md-color-accent-muted` | Link underline / subtle accent |
| `--md-color-border` | Separators, horizontal rules, table borders |
| `--md-color-code-bg` | Inline code + code block background |
| `--md-color-code-fg` | Inline code + code block foreground |
| `--md-color-quote-bar` | Blockquote left border |
| `--md-color-table-stripe` | Zebra-stripe color on table rows |
| `--md-color-selection-bg` | `::selection` background |

## Stable HTML hooks

The renderer emits semantic HTML. Themes can rely on these class names and
data attributes:

- `.marginalia` — root article wrapper.
- `[data-block="<id>"]` — every top-level block. The viewer uses these IDs
  to place comment anchors. Themes should treat `data-block` as invisible.
- `pre.shiki.language-<lang>` — syntax-highlighted code block.
  Shiki dual-theme colors expose `--shiki-light`, `--shiki-dark`, and
  per-token background/style variables.
- `div.mermaid` — a mermaid diagram source block, client-side rendered.
  Carries `data-mermaid-index` and `data-mermaid-mode`.
- Heading elements (`h1`–`h6`) carry a stable `id` attribute (Unicode-safe
  slug) that the TOC links to.

## Shipping a custom theme

Minimum viable theme: one `.css` file that sets at least the colors and
base font. Optionally `@import './default.css'` first to inherit the
structural rules, then override only what you need.

Built-in themes in this package:

- `@marginalia/themes/default` (light + dark via `[data-appearance]`)
- `@marginalia/themes/handbook`
- `@marginalia/themes/beautiful`
- `@marginalia/themes/book`
- `@marginalia/themes/article`
- `@marginalia/themes/technical`
- `@marginalia/themes/serif-print` (intended for PDF export)
