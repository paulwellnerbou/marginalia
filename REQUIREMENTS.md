# Marginalia — Requirements

A web app for rendering, sharing, and collaboratively commenting on Markdown
documents. The rendering engine is reusable outside the app.

This document captures the requirements as discussed. Items marked **[OPEN]**
are decisions that still need your input before implementation. Items marked
**[ASSUMED]** are defaults I picked to keep the spec complete — change them if
you disagree.

---

## 1. Scope

Two separately reusable parts:

1. **Renderer** — pure library + CLI that turns Markdown into themed HTML.
   No browser dependency. Used by the web app, but also usable standalone.
2. **App** — a collaborative viewer similar to HedgeDoc, with commenting,
   password protection, git-backed history, and real-time notifications.

The renderer must be embeddable in other webapps. **[OPEN]** Embedding form:
Web Component (custom element + Shadow DOM), React component, or iframe?
See §4.

---

## 2. Renderer

### 2.1 Library API

* Runs in Node/Bun (no DOM). Input: Markdown string (+ options). Output: HTML
  string + metadata (extracted TOC, heading anchors, referenced assets,
  unresolved references, mermaid blocks found, etc.).
* Deterministic: same input → same output (important for git diffs).
* Pluggable, but ships with the feature set below enabled by default.

### 2.2 CLI

* `marginalia render <file.md> [--theme=<name>] [--out=<file.html>]`
* `marginalia render --stdin` (reads from stdin, writes to stdout)
* `marginalia themes list` / `marginalia themes show <name>`
* Exit non-zero on broken in-document references (configurable).

### 2.3 Features required

| # | Feature | Notes |
|---|---------|-------|
| R1 | Beautiful default typography | System-quality defaults, not framework-looking. See §2.5. |
| R2 | Themeable via CSS only | HTML output is identical across themes; only CSS changes. Class/attribute contract is stable and documented. |
| R3 | Pipe tables | GFM-style. |
| R4 | Grid tables | **Pandoc-style** grid tables: `+---+---+` corners, `|` separators, supports row/column spanning and block content (lists, code, paragraphs) inside cells. Raw HTML `<table>` is also always available as an escape hatch. |
| R5 | Images | JPG / PNG / SVG, plus GIF / WebP / AVIF. Relative paths resolve against the document's storage directory (see §3.5). Lazy-loading + intrinsic sizing in output. |
| R6 | In-document references | Works even when heading text contains non-ASCII, emoji, punctuation, or duplicates. Slug algorithm is deterministic and documented. Broken references surface as a warning (renderer metadata) rather than silent failure. |
| R7 | Mermaid | Diagrams preserved as `<pre class="mermaid">…</pre>` with the original source. **Client-side rendering is the default** (small runtime loaded on demand). **Server-side rendering to static SVG must also work** (required for the export feature, §3.9). Implementation: `@mermaid-js/mermaid-cli` or a headless-browser approach; picked in the plan. |
| R8 | Code blocks w/ syntax highlighting | Via Shiki (VS Code grammars; produces static, theme-aware HTML — no client runtime needed for highlighting itself). Language auto-detection off; requires fenced `lang` tag. |
| R9 | Inline HTML | Supported as in CommonMark/GFM. Sanitized by default (configurable). The sanitizer allowlist is documented and extensible. |

### 2.4 Slug / anchor algorithm (addresses R6)

* Unicode-aware: keep letters/numbers in any script, lowercase where
  applicable, replace whitespace and most punctuation with `-`.
* Deduplicate with `-2`, `-3`, … suffixes in document order.
* Output anchor ID attached to the heading; also emitted in renderer metadata
  so the TOC component uses the same value, not a reimplementation.

### 2.5 Typography baseline

* Readable body column width with a configurable `max-width` (app exposes it;
  library emits a CSS variable — see §2.6).
* Proper vertical rhythm, distinct heading scale, good code/body font pairing,
  tuned list and blockquote spacing, table styling that works at narrow
  widths, figure captions.

### 2.6 Theming contract

* All themes are a CSS file (optionally + a font bundle).
* Themes express themselves via CSS custom properties (`--md-*`) for things
  that should be overridable at runtime (max-width, line-height, base font,
  colors) and via plain rules for structural styling.
* Switching theme = swapping one `<link>`. HTML does not change.
* Built-in themes at launch: **[ASSUMED]** `default-light`, `default-dark`,
  and `serif-print`. Extend later.

---

## 3. App

### 3.1 Identity & auth

* No accounts. A user is identified by a `localStorage` entry (a client-side
  ID + display name).
* On first action that requires identity (upload, comment), prompt for a
  display name; store it.
* The uploader of a document is its **admin** (their client ID is recorded).

### 3.2 Documents

* Uploaded Markdown gets a UID-style URL (ULID or nanoid; URL-safe, ~22 chars).
* Default visibility: **public read**.
* On upload, the admin can choose:
  * password-protect viewing (password is auto-generated and shown once),
  * allow non-admin editing (on/off).
* Editing: **source editing only** (no WYSIWYG). HedgeDoc-style split view:
  source on one side, rendered HTML on the other.
* If a document is password-protected, the password gates **everything**
  related to that document: reading, editing, commenting, viewing history,
  exporting.

### 3.3 Versioning

* Every document is a file in a server-side **git repo**. Each save is a
  commit, authored as the editing user (display name + client ID in commit
  trailer).
* History view: list of commits, diff between any two versions, restore to a
  previous version (creates a new commit).
* **[ASSUMED]** One git repo, documents stored as `<uid>.md` at the root, plus
  a sibling `<uid>/` directory for attached assets.

### 3.4 Layout

Three panes, all resizable; TOC and Comments independently collapsible:

```
┌──────────┬──────────────────────────┬──────────┐
│   TOC    │        Document          │ Comments │
│ (collap- │ (rendered HTML; edit mode│ (collap- │
│  sible)  │  = split source / preview)│  sible)  │
└──────────┴──────────────────────────┴──────────┘
```

* Document max-width is adjustable per user (slider; persisted in
  localStorage).
* TOC is generated from the same anchor metadata the renderer emits.

### 3.5 Assets

* Images referenced in Markdown can be uploaded and are stored under the
  document's asset directory. They're committed alongside the Markdown.
* **Upload size limit**: **10 MB per file, 100 MB per document** (aggregated
  across all assets). Configurable server-side.

### 3.6 Comments

* **Selection-anchored**: user selects text or a paragraph in the rendered
  document and attaches a comment. A comment is anchored to:
  * the target block's stable ID (from renderer metadata),
  * a normalized text quote of the selection,
  * a few characters of surrounding context for disambiguation,
  * character offsets within the block.
* **Edit/delete permissions**: author can edit and delete their own comment;
  document admin can delete any comment (but not edit others').
* **Threading**: threaded replies are supported. Each comment anchor has a
  top-level comment and an ordered list of replies. Replies are not
  themselves re-anchorable — they inherit their parent's anchor. Edit/delete
  rules apply per reply (author, or admin can delete).
* **Re-anchoring on document change**: when a commit modifies the document,
  each existing comment is re-matched using fuzzy text match (quote + context
  + block ID). Three outcomes:
  * **Confident match** → comment is silently re-attached.
  * **Low-confidence match** → comment is attached to the proposed location
    but flagged ("this comment may have moved") with a link to confirm.
  * **No match** → comment is moved to an **orphaned comments** list,
    preserved with its original quote and a "resolve" / "reattach" action.

### 3.7 Real-time collaboration

* WebSocket channel per document.
* Events broadcast to other viewers of the same document:
  * new comment / comment edited / comment deleted,
  * document content changed (only on a real content change — ignore
    whitespace-only / trailing-newline commits; `git diff --ignore-all-space`
    as the check).
* Clients show an **in-browser notification** (the Notifications API if
  granted, else an in-app toast).
* Concurrent editing (CRDT/OT) is **not in v1** — last-write-wins with an
  "another user is editing" warning if a second editor opens the document.
  The design must **not preclude** adding real-time concurrent editing
  later: the editor component is chosen to have a mature CRDT binding (e.g.
  CodeMirror 6 + Yjs), the save path is a discrete operation that can
  coexist with a CRDT document state, and the WebSocket channel already
  carries per-document events.

### 3.8 Export (PDF / Word)

* Each document can be exported to **PDF** and **Word (.docx)**, using the
  currently selected theme for visual styling.
* All content must render server-side, including mermaid diagrams (→ static
  SVG) and syntax-highlighted code blocks (already static from Shiki).
* Available from the viewer UI and from the CLI
  (`marginalia export <file.md> --format=pdf|docx`).
* **[ASSUMED]** PDF via headless Chromium printing the rendered HTML with the
  active theme's print stylesheet; DOCX via a Markdown → DOCX converter
  (e.g. Pandoc invocation, or a native TS library like `docx`). Trade-offs
  between these — especially whether to require Pandoc as an external
  dependency — are decided in the plan.

### 3.9 Theme editor

* Live editor for typography, spacing, paragraphs, line-height, colors.
* Operates on the theme's CSS custom properties (§2.6). Live preview via
  setting the variables on the preview pane.
* Themes can be saved (named) and exported/imported as a JSON/CSS file.
* **Theme scope**: the document admin sets the **document's default theme**
  (applies to all readers, used by exports). Each individual reader can
  **override the theme locally for that document** — this override is
  stored in their `localStorage`, keyed by document UID, and never leaves
  their browser. A reader can always reset to the document default.

---

## 4. Embedding

The renderer is reusable in other webapps via three forms (confirmed):

* **Primary**: a **Web Component** (`<marginalia-doc src="…">` or with inline
  markdown), using **Shadow DOM** for style isolation. Works in any framework
  or plain HTML. Themes apply via slotted CSS or a `theme=` attribute.
* **Secondary**: a thin **React wrapper** around the web component, for
  ergonomics in React codebases.
* **Fallback**: **iframe embed** (`/embed/<uid>`) for strict sandboxing or
  cross-origin cases.

---

## 5. Non-functional

* **Tech stack**: Bun + TypeScript. Node is avoided unless a dependency forces
  it. Framework choice discussed in the plan (§ see PLAN.md).
* **Determinism**: renderer output is byte-stable so git diffs of generated
  HTML (if ever generated) are meaningful.
* **Accessibility**: rendered HTML uses semantic elements (`<article>`,
  `<nav>`, `<figure>`, `<table>` with `<thead>`/`<tbody>`), heading
  hierarchy preserved, anchors are focusable, images require alt text
  (warning if missing).
* **Security**: inline HTML is sanitized; uploaded assets served with safe
  Content-Type + `Content-Disposition`; passwords hashed (argon2id); no
  arbitrary script execution from Markdown.
* **Performance target (first cut)**: render a 200 KB Markdown document
  server-side in <200 ms; first meaningful paint of the viewer <1 s on
  broadband.

---

## 6. Out of scope (v1)

* User accounts / OAuth.
* Full-text search across all documents.
* Import from Google Docs, Notion, etc.
* Mobile-native apps.
* Multi-tenant / organizations.

---

## 7. Open questions (summary)

* Export: is requiring **Pandoc** as a server-side dependency acceptable for
  DOCX output, or should DOCX be pure-JS (lower fidelity)? (§3.8)
