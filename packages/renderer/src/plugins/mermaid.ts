import type { Code, Html, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import type { MermaidBlock } from '../types.js';

export interface MermaidOptions {
  mode: 'client' | 'svg';
}

/**
 * Convert ```mermaid fenced blocks to `<div class="mermaid">…</div>` so the
 * browser runtime can render them. Records each block in file.data.mermaid.
 *
 * 'svg' mode (server-side render to inline SVG) is planned for the export
 * feature. Not implemented here — falls back to client mode for now and
 * records the blocks so the export pipeline can post-process.
 */
export const remarkMermaid: Plugin<[MermaidOptions], Root> = (options) => {
  const mode = options.mode;
  return (tree, file) => {
    const blocks: MermaidBlock[] = [];
    let index = 0;

    visit(tree, 'code', (node: Code, idx, parent) => {
      if (node.lang !== 'mermaid' || !parent || idx === undefined) return;

      const source = node.value;
      blocks.push({ index, source });

      const replacement: Html = {
        type: 'html',
        value: renderClientSide(source, index, mode),
      };
      parent.children[idx] = replacement;
      index += 1;
    });

    (file.data as { mermaid?: MermaidBlock[] }).mermaid = blocks;
  };
};

function renderClientSide(source: string, index: number, mode: 'client' | 'svg'): string {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // A `<div>` is the idiomatic host for a mermaid diagram — avoids the
  // default `<pre>` styling (monospace, code-block background, whitespace
  // preservation) which conflicts with the inline SVG mermaid injects.
  // data-mermaid-mode marks the intended render mode so the export step can
  // find blocks that still need SSR even if the pipeline was asked for 'svg'
  // but has no SSR backend wired up yet.
  return `<div class="mermaid" data-block-kind="mermaid" data-mermaid-index="${index}" data-mermaid-mode="${mode}">${escaped}</div>`;
}
