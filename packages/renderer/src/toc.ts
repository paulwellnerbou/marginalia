import type { Anchor, TocNode } from './types.js';

/**
 * Build a nested TOC from a flat list of heading anchors.
 * Handles skipped levels sensibly (e.g. h1 → h3 still nests under h1).
 */
export function buildToc(anchors: Anchor[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const a of anchors) {
    const node: TocNode = { ...a, children: [] };

    while (stack.length > 0 && stack[stack.length - 1]!.level >= a.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1]!.children.push(node);
    }
    stack.push(node);
  }
  return root;
}
