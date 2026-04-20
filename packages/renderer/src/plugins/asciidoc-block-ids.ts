import type { Plugin } from 'unified';
import type { Root, Element, ElementContent, Properties } from 'hast';
import { visit } from 'unist-util-visit';
import type { BlockMap } from '../types.js';
import {
  MARGINALIA_BLOCK_MARKER_PREFIX,
  MARGINALIA_SUBBLOCK_MARKER_PREFIX,
  type SubBlockEntry,
} from '../asciidoc-markers.js';

export interface AsciidocBlockIdsOptions {
  blocks: BlockMap;
  subBlocks: SubBlockEntry[];
}

/**
 * Attach `data-block="<content-hash>"` to each HTML element that
 * `renderAsciidoc`'s pre-render walk tagged with a marker role, and
 * `data-subblock="<content-hash>"` to `<li>` elements tagged with the
 * sub-block marker. Marker classes are stripped afterwards so they don't
 * leak through the sanitized output.
 *
 * Marker → lookup mapping relies on the pre-render walks (top-level
 * blocks + sub-block list items) emitting entries in document order with
 * indices that match the arrays passed in. If those ever drift you'd
 * get mis-anchored comments, so they're produced by the same function
 * in render-asciidoc.ts.
 */
export const rehypeAsciidocBlockIds: Plugin<[AsciidocBlockIdsOptions], Root> = (options) => {
  const { blocks, subBlocks } = options;
  return (tree) => {
    visit(tree, 'element', (node: Element) => {
      const classes = getClassList(node);
      if (classes.length === 0) return;
      let blockIdx: number | null = null;
      let subBlockIdx: number | null = null;
      const remaining: string[] = [];
      for (const cls of classes) {
        if (cls.startsWith(MARGINALIA_BLOCK_MARKER_PREFIX)) {
          if (blockIdx === null) {
            const n = Number.parseInt(cls.slice(MARGINALIA_BLOCK_MARKER_PREFIX.length), 10);
            if (Number.isFinite(n)) blockIdx = n;
          }
          continue;
        }
        if (cls.startsWith(MARGINALIA_SUBBLOCK_MARKER_PREFIX)) {
          if (subBlockIdx === null) {
            const n = Number.parseInt(cls.slice(MARGINALIA_SUBBLOCK_MARKER_PREFIX.length), 10);
            if (Number.isFinite(n)) subBlockIdx = n;
          }
          continue;
        }
        remaining.push(cls);
      }
      if (blockIdx === null && subBlockIdx === null) return;

      const props: Properties = (node.properties ??= {});

      if (blockIdx !== null) {
        const info = blocks[blockIdx];
        if (info) props['data-block'] = info.id;
      }
      if (subBlockIdx !== null) {
        const entry = subBlocks[subBlockIdx];
        if (entry) props['data-subblock'] = entry.id;
      }

      setClassList(node, remaining);

      // For section wrappers, asciidoctor emits
      //   <div class="sect1"> <h2 id="..."> ... </div>
      // We want data-block on the heading element itself (mirrors mdast's
      // heading node). If the current element is a section wrapper (had
      // the sect{N} class) and it contains a heading, move data-block.
      if (blockIdx !== null && isSectionWrapper(remaining)) {
        const info = blocks[blockIdx];
        if (info) {
          const heading = findFirstHeading(node);
          if (heading) {
            heading.properties ??= {};
            heading.properties['data-block'] = info.id;
            delete props['data-block'];
          }
        }
      }
    });
  };
};

function getClassList(node: Element): string[] {
  const cls = node.properties?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === 'string') return cls.split(/\s+/).filter(Boolean);
  return [];
}

function setClassList(node: Element, list: string[]): void {
  if (!node.properties) node.properties = {};
  if (list.length === 0) delete node.properties.className;
  else node.properties.className = list;
}

function isSectionWrapper(classes: string[]): boolean {
  return classes.some((c) => /^sect\d+$/.test(c));
}

function findFirstHeading(node: Element): Element | null {
  for (const child of node.children as ElementContent[]) {
    if (child.type !== 'element') continue;
    if (/^h[1-6]$/.test(child.tagName)) return child;
    const deeper = findFirstHeading(child);
    if (deeper) return deeper;
  }
  return null;
}
