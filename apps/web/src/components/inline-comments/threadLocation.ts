/**
 * Where in the document a thread sits, as the chain of headings above its
 * anchor — the breadcrumb line at the top of a thread card.
 *
 * Read from the current block map rather than the heading path the anchor
 * stored: that one is a snapshot from when the comment was written, and
 * goes stale once a heading is renamed or the block moves to another
 * section. The stored path is only the fallback for an anchor whose block
 * is gone.
 */

import type { SectionContext } from '@marginalia/renderer/section-score';
import { createContext, useContext } from 'react';
import { chooseBySection } from '../../lib/anchor-target.js';
import type { ThreadAnchor } from '../../lib/api.js';

type LocatedBlock = SectionContext & { id: string };

export interface ThreadLocationIndex {
  byId: ReadonlyMap<string, readonly LocatedBlock[]>;
  /**
   * A heading every titled block sits under — the document's own title
   * heading. Repeating it on every card says nothing, so it is cut.
   */
  title: string | null;
}

export function buildThreadLocationIndex(blocks: readonly LocatedBlock[]): ThreadLocationIndex {
  const byId = new Map<string, LocatedBlock[]>();
  let title: string | null | undefined;
  for (const block of blocks) {
    const list = byId.get(block.id);
    if (list) list.push(block);
    else byId.set(block.id, [block]);
    const root = block.headingPath[0];
    if (root === undefined || title === null) continue;
    title = title === undefined || title === root ? root : null;
  }
  return { byId, title: title ?? null };
}

/** The headings above `anchor`, outermost first; empty when there are none to show. */
export function threadHeadingPath(index: ThreadLocationIndex, anchor: ThreadAnchor): string[] {
  // A block id is a content hash, so a repeated block is one id on several
  // entries; the anchor's stored section says which one it is.
  const candidates = anchor.block_id ? index.byId.get(anchor.block_id) : undefined;
  const block = candidates ? chooseBySection(candidates, (b) => b, anchor) : null;
  const path = block?.headingPath ?? anchor.heading_path ?? [];
  return index.title !== null && path[0] === index.title ? path.slice(1) : [...path];
}

const ThreadLocationContext = createContext<ThreadLocationIndex | null>(null);

export const ThreadLocationProvider = ThreadLocationContext.Provider;

/** Null outside a document layout — the card then shows no breadcrumb. */
export function useThreadLocationIndex(): ThreadLocationIndex | null {
  return useContext(ThreadLocationContext);
}
