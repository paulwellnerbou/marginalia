# Marginalia — Implementation Plan

Companion to `REQUIREMENTS.md`. This plan proposes a tech stack, a repository
layout, and a phased build order. Everything is a recommendation — flag
anything you want to change before we start.

---

## 1. Tech choices (with rationale)

### 1.1 Runtime & language

* **Bun + TypeScript** throughout. Single runtime for CLI, server, tests.
* **Node compatibility**: the renderer package stays pure TS with no Bun-only
  APIs so it can also run on Node, since users embedding it may not use Bun.

### 1.2 Markdown pipeline — `remark` / `rehype` (unified)

Considered:

| Option | Pros | Cons |
|---|---|---|
| **`remark` + `rehype` (unified)** | AST-based, huge plugin ecosystem, clean separation of parse/transform/stringify, easy to add our own plugins for in-doc references, grid tables, mermaid, etc. | Slightly more setup than `markdown-it`. |
| `markdown-it` | Fastest, simple plugin model. | AST is token stream, harder to do clean transforms (e.g. re-anchoring, asset discovery). |
| `micromark` alone | Fastest CommonMark core. | Too low-level for our needs; unified already uses it under the hood. |

**Decision**: unified / remark / rehype. Specific plugins:

* `remark-parse`, `remark-gfm` (pipe tables, strikethrough, task lists)
* `remark-frontmatter` (YAML frontmatter for per-document metadata)
* `remark-grid-table` or a custom plugin for Pandoc-style grid tables
* Custom plugin: **in-document references** with Unicode-aware slugger
  (wraps `github-slugger` with tweaks; emits anchor map in the file's
  `data.anchors`)
* Custom plugin: **mermaid handling** — by default, converts ` ```mermaid `
  blocks to `<pre class="mermaid">` for client-side rendering and records
  the source in `data.mermaid`. With `serverRenderMermaid: true`, the
  plugin pre-renders each diagram to inline SVG (used by the export
  pipeline, §6a). Server-side renderer: `@mermaid-js/mermaid-cli` behind a
  small worker pool, reusing one Chromium instance across diagrams.
* Custom plugin: **asset collector** (records referenced image paths in
  `data.assets`)
* `remark-rehype` with `allowDangerousHtml: true`
* `rehype-raw` to re-parse inline HTML
* `rehype-sanitize` with a custom schema (allows class attrs, mermaid, target
  for links, etc.)
* `rehype-shiki` for syntax highlighting (Shiki; dual-theme light/dark)
* `rehype-stringify` to produce HTML

### 1.3 App framework — `Hono` on Bun, React SPA frontend

Considered:

* **Next.js**: a lot of features we don't need (SSR, RSC, Edge) and its fit
  with Bun is still second-class. Overkill here.
* **SvelteKit**: great fit, but you said TS/React ecosystem familiarity is
  likely; picking React unless you prefer Svelte.
* **Hono (Bun-native)** for the HTTP / WebSocket server + a **Vite + React**
  SPA frontend. Minimal, fast, first-class Bun support, trivial to wire up
  WebSockets.

**Decision**: Hono (server) + Vite + React + TypeScript (frontend).
SPA-style: the server serves JSON + WebSocket events + a static bundle. No
SSR required; the renderer already produces good HTML from the API.

### 1.4 Storage

* **Git** for Markdown document contents + assets (requirement §3.3).
  Implemented with `isomorphic-git` (pure JS; avoids shelling out and
  works identically in tests). One repository at `var/repo/`.
* **SQLite** via `bun:sqlite` for metadata that doesn't belong in git:
  * documents (uid, path, admin client ID, password hash, visibility,
    editable-by-non-admin flag, created/updated),
  * comments (id, doc uid, **parent_id nullable** for threaded replies,
    anchor payload [null on replies — inherited from parent], author
    client ID + display name, created/updated/deleted),
  * users-lite (client ID ↔ display name; optional, mainly for display
    convenience).
* **Passwords**: hashed with argon2id (`@node-rs/argon2` — works on Bun).

### 1.5 Realtime

* Bun's native `WebSocket` via Hono's upgrade handler.
* In-process pub/sub per document UID. Single-node only in v1 — adding Redis
  later is trivial if we need horizontal scaling.

### 1.6 Comment re-anchoring

* Library: `diff-match-patch` (Google) for fuzzy text matching.
* Algorithm: see §3 below.

### 1.7 Embedding

* Build the renderer's browser-side glue (mermaid loader + copy-to-clipboard
  + anchor scroll) as a **custom element** (`<marginalia-doc>`) with Shadow
  DOM and a `theme` attribute. Publish as `@marginalia/element`.
* Publish a tiny React wrapper `@marginalia/react` that mounts the element.
* The app also exposes `/embed/<uid>` for iframe consumers.

---

## 2. Repository layout (monorepo)

Single repo, Bun workspaces. Suggested packages:

```
marginalia/
├── packages/
│   ├── renderer/          # pure library: markdown → HTML + metadata
│   │   ├── src/
│   │   ├── test/
│   │   └── package.json
│   ├── cli/               # `marginalia` CLI; depends on renderer
│   ├── element/           # <marginalia-doc> web component
│   ├── react/             # React wrapper around the element
│   └── themes/            # CSS themes + theme JSON schema
├── apps/
│   ├── server/            # Hono + Bun + SQLite + isomorphic-git
│   └── web/               # Vite + React SPA (viewer/editor UI)
├── var/                   # runtime data (gitignored): repo/, db.sqlite
├── REQUIREMENTS.md
├── PLAN.md
└── package.json           # workspaces root
```

Rationale: the renderer and CLI are independently publishable and don't carry
app code; the element + react packages are small and thin; apps are
deploy-targets, not libraries.

---

## 3. Renderer contract & comment anchoring

### 3.1 Renderer output shape

```ts
type RenderResult = {
  html: string;                 // the rendered HTML fragment
  anchors: Anchor[];            // heading anchors, in doc order
  toc: TocNode[];               // nested TOC built from anchors
  assets: AssetRef[];           // image/file refs found in the doc
  mermaid: MermaidBlock[];      // mermaid sources found
  blocks: BlockMap;             // stable block IDs → source range + text
  warnings: Warning[];          // broken refs, missing alt text, etc.
};
```

`BlockMap` is the key addition for commenting. For every top-level block
(paragraph, list, table, heading, code block, etc.) we emit a **content-hash-
based stable ID** placed on the rendered element as `data-block="<id>"`. The
ID is `sha1(normalized text prefix + block kind)` truncated — it survives
minor edits elsewhere in the document and changes when the block itself
changes.

### 3.2 Comment anchor payload

Stored in SQLite as JSON:

```ts
type CommentAnchor = {
  blockId: string;       // from BlockMap
  quote: string;         // exact selected text (normalized)
  prefix: string;        // ~32 chars before the selection
  suffix: string;        // ~32 chars after the selection
  startOffset: number;   // char offset within block text
  endOffset: number;
};
```

### 3.3 Re-anchoring pass (runs on every commit)

For each comment:

1. Look up the block by `blockId` in the new `BlockMap`. If found and `quote`
   is still present at the old offsets (±small window) → **confident match**.
2. Else, search within the block's text for the quote (exact first, then
   `diff-match-patch` fuzzy). If match score ≥ threshold → **confident**.
3. Else, search the whole new document for `prefix + quote + suffix`. Match
   score ≥ threshold but block changed → **low-confidence match**, flag it.
4. Else → **orphaned**. Keep it; surface it in an orphaned list.

Thresholds are tuneable; start with 0.75 for "confident", 0.5 for "low".

---

## 4. Auth, passwords, identity

* **Client ID**: random 128-bit ID generated on first visit, stored in
  `localStorage` as `marginalia.clientId`. Display name in
  `marginalia.displayName`.
* Both are sent on write requests in an `X-Marginalia-Client` header; the
  server trusts them for *identity of a non-privileged actor* only (anyone
  can set any client ID — this is fine because we only use it for
  authorship/ownership checks; nothing privileged depends on it beyond
  "delete your own comment").
* **Document admin** check uses the same trust model — the admin is whoever
  holds the admin client ID that was recorded at upload time. To support
  device loss, the upload response includes a one-time **admin recovery
  token**; presenting it re-binds admin to the current client ID.
* **Password-protected documents**: server issues a short-lived JWT cookie
  after a correct password. All reads/writes of that doc require the cookie.

---

## 5. Security posture

* HTML sanitization on the server, not the client, with a documented
  allowlist. No `<script>` from Markdown, ever.
* Uploaded assets served from `/assets/<uid>/<file>` with `Content-Type`
  from a strict magic-byte sniff + `Content-Disposition: inline` only for
  image MIME types; other types download-only.
* CSP for the app: `default-src 'self'`; mermaid's client code is
  self-hosted, not CDN.
* Password rate-limit: 5 attempts / 10 min / IP per document.

---

## 6. Phases

Each phase is independently demoable. Suggested order — we can reorder.

### Phase 0 — Scaffold (half a day)

* Monorepo + Bun workspaces, shared TS config, Biome/ESLint, Vitest.
* CI: type-check + test on every commit (GitHub Actions, Bun image).

### Phase 1 — Renderer core (2–3 days)

* Parse → HTML pipeline with GFM tables, grid tables, inline HTML sanitizer,
  Shiki, mermaid passthrough, image handling, Unicode slugger.
* Deterministic output test suite (golden files).
* Expose `RenderResult` shape (§3.1).

### Phase 2 — CLI + default theme (1 day)

* `marginalia render`, `marginalia themes list/show`, stdin/stdout mode.
* Ship `default-light`, `default-dark`, `serif-print` as plain CSS files.
* Document the theming contract (CSS variables + class names).

### Phase 3 — Server skeleton (2 days)

* Hono app on Bun, SQLite schema, isomorphic-git repo bootstrap.
* Endpoints: upload, get, list metadata, edit (new commit), history, diff,
  restore. Auth middleware (client header, password cookie, admin check).

### Phase 4 — Viewer UI (2–3 days)

* Vite + React SPA. Three-pane layout with resizable/collapsible TOC and
  comments. Document max-width slider (persisted).
* Read view renders via the renderer (server-side render on fetch; client
  receives HTML + metadata).
* Edit view: split source/preview. Editor = **CodeMirror 6** (also chosen
  to keep the door open for a future Yjs/CRDT binding — see §7 risks /
  future-CRDT note).

### Phase 5 — Comments (2–3 days)

* Selection → anchor capture (block ID + quote + prefix/suffix + offsets).
* Render comment markers in the right pane, aligned with the document pane.
* **Threaded replies**: one level of replies under each top-level comment.
  Replies inherit the parent's anchor (no separate re-anchoring).
* Edit/delete permissions per §3.6.
* Re-anchor on commit (§3.3); orphaned-comments list.

### Phase 6 — Realtime (1 day)

* WebSocket channel per document UID.
* Emit comment + content-change events; debounce content-change; skip
  whitespace-only changes (`git diff --ignore-all-space`).
* Browser notifications with toast fallback.

### Phase 7 — Theme editor (1–2 days)

* Live editor for CSS variables. Save/load named themes; export/import.
* Per-document default theme (admin) + per-user override.

### Phase 7a — Export: PDF + DOCX (2–3 days)

* CLI: `marginalia export <file.md> --format=pdf|docx --theme=<name>`.
* Server endpoints: `GET /doc/<uid>/export.pdf`, `…/export.docx`.
* **PDF**: render HTML with the selected theme + print stylesheet, print via
  headless Chromium (`puppeteer-core` + a pinned Chromium, or Playwright —
  pick in Phase 7a). Mermaid pre-rendered to SVG (renderer option from §1.2).
* **DOCX**: **[OPEN — see REQUIREMENTS §7 Q7]** two paths:
  * *High fidelity, external dep*: invoke **Pandoc** (server must have it
    installed) to convert Markdown + assets → `.docx`. Mermaid pre-rendered
    to SVG/PNG and referenced as images.
  * *Pure-JS, lower fidelity*: build DOCX directly from our AST via the
    `docx` npm package. No external dep, but features like grid tables and
    nested structures require more code.
  Default recommendation: **Pandoc**, since fidelity matters for exports and
  Pandoc is the gold standard. Fall back path kept in mind.
* Tests: snapshot PDF text layer + DOCX XML for a representative doc.

### Phase 8 — Embedding (1–2 days)

* `<marginalia-doc>` custom element (Shadow DOM, theme attribute).
* React wrapper. `/embed/<uid>` iframe route.

### Phase 9 — Polish

* Accessibility audit, perf pass, docs site.

**Rough total**: ~3.5 focused weeks to feature-complete v1 (with export).

---

## 6.x Future-CRDT provisions (not built, but not blocked)

Concurrent editing isn't in v1 (§3.7), but these choices leave the door
open so it can be added later without a rewrite:

* **Editor**: CodeMirror 6 — has a mature Yjs binding (`y-codemirror.next`).
* **Transport**: our per-document WebSocket already exists and can carry
  `y-websocket`-style updates on a separate message channel.
* **Persistence**: git-commit-on-save is orthogonal to the CRDT doc state.
  A CRDT layer would sit in memory/Redis; saves still produce commits
  authored by whichever user triggered the save.

When we add CRDT: introduce a Yjs document per open-editing session,
bridge it to our save endpoint, and replace the "another user is editing"
warning with a live presence indicator.

## 7. Risks & unknowns

* **Grid tables**: existing remark plugins for Pandoc-style grid tables are
  limited; may need to write our own. Budget a day for this.
* **Comment re-anchoring accuracy**: real-world edits are messy. Plan to
  ship with conservative thresholds + a clear "confirm move" UX rather than
  guess silently.
* **Mermaid in Shadow DOM**: mermaid typically renders into the page. We
  need to give it a shadow-root-aware container. Solvable, but test early.
* **Shiki bundle size** (dual themes + many grammars): load grammars on
  demand on the client; server-rendered highlighted HTML doesn't need the
  runtime at all, so this mostly matters if we ever do client-side
  re-highlighting. Default plan does not.
* **Mobile layout** for three-pane view — auto-collapse side panes on
  narrow viewports; not a v1 risk but worth prototyping early.

---

## 8. What I need from you before starting

1. The last open question in `REQUIREMENTS.md` §7 — **Pandoc for DOCX
   export, yes or no?**
2. Confirmation of the stack picks in §1 — especially
   **Hono + Vite + React** vs. a preferred alternative (Next, SvelteKit, …).
3. Confirmation of the monorepo layout in §2 (or a preference to keep it
   single-package).
4. Green light to start with Phase 0 + 1 (renderer is the critical path;
   everything else depends on its contract).
