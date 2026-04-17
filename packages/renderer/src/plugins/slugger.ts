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
 * Unicode-aware slug:
 * - Lowercase (where the script has case)
 * - Keep letters/numbers in any script (uses \p{L} / \p{N})
 * - Replace runs of anything else with a single '-'
 * - Trim leading/trailing '-'
 * - If the result is empty (all-punct/emoji heading), fall back to 'section'
 */
export function slugify(text: string): string {
  const normalized = text.normalize('NFKC').toLowerCase();
  const kept = normalized.replace(/[^\p{L}\p{N}]+/gu, '-');
  const trimmed = kept.replace(/^-+|-+$/g, '');
  return trimmed || 'section';
}

function dedupe(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}
