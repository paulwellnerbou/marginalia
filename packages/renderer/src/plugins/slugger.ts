import type { Plugin } from 'unified';
import type { Root, Heading } from 'mdast';
import { visit } from 'unist-util-visit';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Anchor, Warning } from '../types.js';

/**
 * Generate a Unicode-safe slug for a heading, and collect anchors for the
 * TOC. The slug is placed on the heading's hProperties so remark-rehype
 * writes it as `id="…"` on the output element.
 *
 * Addresses the explicit requirement that in-document references work even
 * when headings contain non-ASCII, emoji, punctuation, or duplicates.
 */
export const remarkSlugger: Plugin<[], Root> = () => {
  return (tree, file) => {
    const seen = new Map<string, number>();
    const anchors: Anchor[] = [];

    visit(tree, 'heading', (node: Heading) => {
      const text = mdastToString(node).trim();
      const base = slugify(text);
      const id = dedupe(base, seen);

      const data = (node.data ??= {});
      const props = ((data as { hProperties?: Record<string, unknown> })
        .hProperties ??= {});
      (props as Record<string, unknown>).id = id;

      anchors.push({ level: node.depth, text, id });
    });

    (file.data as { anchors?: Anchor[] }).anchors = anchors;

    // Seed warnings array so later plugins can push into it.
    ((file.data as { warnings?: Warning[] }).warnings ??= []);
  };
};

/**
 * Unicode-aware slug modeled on GitHub/GitLab behavior so manually-written
 * `[…](#…)` links work the way users expect:
 *
 * 1. Lowercase (where the script has case)
 * 2. Strip punctuation (`/`, `&`, `,`, `(`, `)`, `·`, etc.) *without*
 *    replacing it with a separator — so `UX/UI-Design` → `uxui-design`,
 *    not `ux-ui-design`.
 * 3. Collapse whitespace runs to a single `-`.
 * 4. Preserve existing `-` and `_` from the source.
 * 5. Collapse multiple `-` and trim leading/trailing `-`.
 * 6. Fall back to `section` if the heading is all-punct/emoji.
 *
 * Unicode letters and digits (Greek, CJK, Cyrillic, umlauts, …) survive
 * via `\p{L}` / `\p{N}`.
 */
export function slugify(text: string): string {
  const normalized = text.normalize('NFKC').toLowerCase();
  // Keep letters, digits, whitespace, `-`, `_`; drop everything else.
  const stripped = normalized.replace(/[^\p{L}\p{N}\s_-]+/gu, '');
  // Replace whitespace with `-`, then collapse multiples, then trim.
  const hyphened = stripped.replace(/\s+/gu, '-').replace(/-+/g, '-');
  const trimmed = hyphened.replace(/^-+|-+$/g, '');
  return trimmed || 'section';
}

function dedupe(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}
