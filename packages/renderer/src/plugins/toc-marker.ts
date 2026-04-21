/**
 * `[TOC]` / `[[_TOC_]]` marker detection.
 *
 * Two de-facto conventions converge: Python-Markdown's `[TOC]` (also
 * used by MkDocs, Typora) and GitLab Flavored Markdown's
 * `[[_TOC_]]` (also recognised by Obsidian). We accept both.
 *
 * A marker is a top-level paragraph whose combined text, trimmed,
 * exactly matches either literal. remark parses `[TOC]` as either a
 * link-reference-fallback or a plain text node depending on the
 * surrounding reference definitions; using `mdast-util-to-string` to
 * compare the rendered text handles both cases without having to
 * reason about which AST shape we got.
 *
 * The plugin replaces each matching paragraph with an HTML node that
 * emits `<div class="marginalia-toc-marker" aria-hidden="true"></div>`.
 * That element:
 *   - survives `rehype-raw` + the sanitizer (we allow `className` /
 *     `ariaHidden` everywhere);
 *   - is hidden by the viewer's CSS so users don't see a blank line;
 *   - is recognised by the DOCX exporter as an injection point for
 *     the native Word TOC field.
 *
 * Deliberately does NOT touch markers nested inside other blocks
 * (inside a blockquote, a list item, a code block, …). Those would
 * be unusual in real documents and parsing them raises the same
 * ambiguity concerns without a clear benefit.
 */

import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { toString } from 'mdast-util-to-string';

export const TOC_MARKER_CLASSNAME = 'marginalia-toc-marker';

const MARKER_HTML = `<div class="${TOC_MARKER_CLASSNAME}" aria-hidden="true"></div>`;

// Accepted stringified forms, after remark has parsed the paragraph.
//
// `[[_TOC_]]` is surprisingly tricky: the inner `_TOC_` gets treated
// as CommonMark intraword emphasis (because `_` adjacent to a `[`/`]`
// punctuation is valid-flanking), so remark builds a paragraph of
// `text("[[") + emphasis("TOC") + text("]]")`. `mdast-util-to-string`
// strips emphasis markers, leaving the user's `[[_TOC_]]` indistinguishable
// from a user-typed `[[TOC]]` at the check point. We therefore accept
// both stringified forms — authors in either camp get what they expect.
const ACCEPTED = new Set(['[TOC]', '[[_TOC_]]', '[[TOC]]']);

export const remarkTocMarker: Plugin<[], Root> = () => {
  return (tree) => {
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (!node || node.type !== 'paragraph') continue;
      const text = toString(node).trim();
      if (!ACCEPTED.has(text)) continue;
      tree.children[i] = { type: 'html', value: MARKER_HTML };
    }
  };
};
