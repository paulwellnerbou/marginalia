import type { Plugin } from 'unified';
import type { Root, Element, ElementContent } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import type { MermaidBlock } from '../types.js';

export interface AsciidocMermaidOptions {
  mode?: 'client' | 'svg';
}

/**
 * Lower AsciiDoc mermaid blocks to the same `<div class="mermaid">` shape
 * the markdown `remarkMermaid` pass produces, so the browser runtime picks
 * them up identically across formats.
 *
 * Two source forms are handled:
 *   1. `[mermaid]` on a listing block  → `<div class="listingblock mermaid">`
 *   2. `[source,mermaid]`              → `<pre><code class="language-mermaid">`
 *
 * In both, we replace the whole asciidoctor wrapper (the listingblock
 * `<div>`) rather than just the `<pre>`, so the block-ids pass attaches
 * `data-block` to the mermaid div itself — matching what the markdown
 * pipeline does.
 */
export const rehypeAsciidocMermaid: Plugin<[AsciidocMermaidOptions?], Root> = (options) => {
  const mode = options?.mode ?? 'client';
  return (tree, file) => {
    const blocks: MermaidBlock[] = [];
    let index = 0;

    const replaceAt = (parent: Element | Root, position: number, container: Element) => {
      const source = extractMermaidSource(container);
      if (!source) return;
      blocks.push({ index, source });

      const preservedClasses = classesFromWrapper(container).filter(
        (c) => c !== 'listingblock' && c !== 'mermaid' && c !== 'content',
      );

      const replacement: Element = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['mermaid', ...preservedClasses],
          'data-block-kind': 'mermaid',
          'data-mermaid-index': String(index),
          'data-mermaid-mode': mode,
        },
        children: [{ type: 'text', value: source }],
      };
      parent.children[position] = replacement;
      index += 1;
    };

    walk(tree, (node, parent, idx) => {
      if (!parent || idx === undefined) return;
      if (node.type !== 'element') return;
      if (!isMermaidWrapper(node)) return;
      replaceAt(parent, idx, node);
    });

    (file.data as { mermaid?: MermaidBlock[] }).mermaid = blocks;
  };
};

function isMermaidWrapper(node: Element): boolean {
  if (node.tagName !== 'div') return false;
  const cls = classesFromWrapper(node);
  if (!cls.includes('listingblock')) return false;
  if (cls.includes('mermaid')) return true;
  // `[source,mermaid]` form — no `mermaid` role on the wrapper; look for
  // `<code class="language-mermaid">` inside.
  return findLanguageMermaidCode(node) !== null;
}

function findLanguageMermaidCode(node: Element): Element | null {
  for (const child of node.children as ElementContent[]) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'code') {
      if (classesFromWrapper(child).includes('language-mermaid')) return child;
    }
    const deeper = findLanguageMermaidCode(child);
    if (deeper) return deeper;
  }
  return null;
}

function extractMermaidSource(wrapper: Element): string | null {
  // Asciidoctor wraps the source either in <pre> or <pre><code>. In both
  // cases we want the innermost text, entities already decoded by the
  // parser.
  const code = findLanguageMermaidCode(wrapper);
  if (code) return hastToString(code);
  const pre = findFirstByTag(wrapper, 'pre');
  if (pre) return hastToString(pre);
  return null;
}

function findFirstByTag(node: Element, tag: string): Element | null {
  for (const child of node.children as ElementContent[]) {
    if (child.type !== 'element') continue;
    if (child.tagName === tag) return child;
    const deeper = findFirstByTag(child, tag);
    if (deeper) return deeper;
  }
  return null;
}

function classesFromWrapper(node: Element): string[] {
  const cls = node.properties?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === 'string') return cls.split(/\s+/).filter(Boolean);
  return [];
}

type Visitor = (
  node: ElementContent | Root,
  parent: Element | Root | null,
  index: number | undefined,
) => void;

function walk(tree: Root, visitor: Visitor): void {
  // Document-order traversal so mermaid indices / `file.data.mermaid`
  // entries match the block order the user sees — same semantics as
  // `remarkMermaid` for the markdown pipeline. Replacements are
  // in-place (parent.children[idx] = …), so they don't shift sibling
  // indices; forward iteration is safe.
  const visit = (node: ElementContent | Root, parent: Element | Root | null, idx: number | undefined) => {
    visitor(node, parent, idx);
    const children = (node as { children?: ElementContent[] }).children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      visit(child, node as Element | Root, i);
    }
  };
  visit(tree, null, undefined);
}
