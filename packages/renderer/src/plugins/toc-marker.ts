/**
 * `[TOC]` / `[[_TOC_]]` marker detection.
 *
 * Two de-facto conventions converge: Python-Markdown's `[TOC]` (also
 * used by MkDocs, Typora) and GitLab Flavored Markdown's
 * `[[_TOC_]]` (also recognised by Obsidian). We accept both.
 *
 * A marker is a top-level paragraph whose mdast structure matches one
 * of those two literals exactly. remark parses `[TOC]` as either a
 * plain text node or a shortcut `linkReference` depending on the
 * surrounding reference definitions, and `[[_TOC_]]` as a specific
 * text/emphasis/text sequence. We intentionally match those AST
 * shapes directly rather than stringifying, to avoid collisions such
 * as `[[__TOC__]]`.
 *
 * The plugin replaces each matching paragraph with an HTML node that
 * emits `<div class="marginalia-toc-marker" aria-hidden="true"></div>`.
 * That element:
 *   - survives `rehype-raw` + the sanitizer (we allow `className` /
 *     `ariaHidden` everywhere);
 *   - is rendered by the viewer's CSS as a visible pill badge marking
 *     the TOC insertion point;
 *   - is recognised by the DOCX exporter as an injection point for
 *     the native Word TOC field.
 *
 * Deliberately does NOT touch markers nested inside other blocks
 * (inside a blockquote, a list item, a code block, …). Those would
 * be unusual in real documents and parsing them raises the same
 * ambiguity concerns without a clear benefit.
 */

import type { Plugin } from 'unified';
import type {
  Emphasis,
  LinkReference,
  Paragraph,
  PhrasingContent,
  Root,
  Text,
} from 'mdast';

export const TOC_MARKER_CLASSNAME = 'marginalia-toc-marker';

const MARKER_HTML = `<div class="${TOC_MARKER_CLASSNAME}" aria-hidden="true"></div>`;

export const remarkTocMarker: Plugin<[], Root> = () => {
  return (tree) => {
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (!node || node.type !== 'paragraph') continue;
      if (!isTocMarkerParagraph(node)) continue;
      tree.children[i] = { type: 'html', value: MARKER_HTML };
    }
  };
};

/**
 * Detect the two literal forms of a TOC marker by the PARSED mdast
 * structure, not by the stringified text.
 *
 *  Form A  `[TOC]`       → paragraph with a single text child,
 *                          OR a shortcut `linkReference` with label
 *                          "TOC" when the doc happens to contain a
 *                          `[TOC]: url` reference definition (remark
 *                          flips unresolved refs to text but turns
 *                          them into `linkReference` the moment a
 *                          matching definition appears anywhere in
 *                          the doc).
 *  Form B  `[[_TOC_]]`   → paragraph with [text("[["), emphasis("TOC"), text("]]")].
 *
 * Checking structure lets us tell `[[_TOC_]]` (`emphasis`, intended as a
 * marker) apart from `[[__TOC__]]` (`strong`, intended as literal
 * bolded text in a document). The shared text representation —
 * `mdast-util-to-string` strips both emphasis markers and both render
 * as `[[TOC]]` after stringification — made the previous text-based
 * matcher collide with the strong-emphasis case, so authors couldn't
 * write `[[__TOC__]]` in their prose without it being swallowed.
 *
 * The shortcut-reference variant also keeps `[Read more][TOC]` (a
 * FULL reference pointing at the `[TOC]: url` definition) working as
 * a real link — that's `referenceType: 'full'` with non-`TOC` children,
 * which doesn't match the shortcut predicate below.
 */
function isTocMarkerParagraph(node: Paragraph): boolean {
  // Form A: plain `[TOC]` (no matching ref def anywhere in the doc),
  // OR a SHORTCUT `[TOC]` reference whose label is exactly "TOC"
  // (matching ref def exists).
  if (node.children.length === 1) {
    const only = node.children[0];
    if (only && only.type === 'text' && only.value.trim() === '[TOC]') return true;
    if (
      only &&
      only.type === 'linkReference' &&
      (only as LinkReference).referenceType === 'shortcut' &&
      (only as LinkReference).identifier === 'toc' &&
      isSingleTextChild((only as LinkReference).children, 'TOC')
    ) {
      return true;
    }
  }
  // Form B: `[[_TOC_]]`. remark-gfm's parser splits this into three
  // phrasing children around an emphasis wrapper — the emphasis is
  // what distinguishes it from the strong-emphasis variant.
  if (node.children.length === 3) {
    const [open, mid, close] = node.children as [
      PhrasingContent,
      PhrasingContent,
      PhrasingContent,
    ];
    if (
      open.type === 'text' &&
      (open as Text).value.trim() === '[[' &&
      mid.type === 'emphasis' &&
      isSingleTextChild((mid as Emphasis).children, 'TOC') &&
      close.type === 'text' &&
      (close as Text).value.trim() === ']]'
    ) {
      return true;
    }
  }
  return false;
}

function isSingleTextChild(
  children: readonly PhrasingContent[],
  expected: string,
): boolean {
  if (children.length !== 1) return false;
  const only = children[0];
  return !!only && only.type === 'text' && (only as Text).value === expected;
}
