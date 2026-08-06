import type { TocNode } from './api.js';
import { setSectionCollapsed } from './heading-collapse.js';

/**
 * Section filter ("focus mode"): the reader picks one or more headings
 * in the TOC; everything outside those subtrees collapses and the
 * thread surfaces hide threads anchored elsewhere.
 *
 * All heading identity is the slug id the renderer puts on heading
 * elements — the same id TOC nodes carry — so no text matching is
 * involved anywhere.
 */

export type SectionRelation = 'selected' | 'ancestor' | 'descendant' | 'unrelated';

/**
 * Relation of every TOC heading to the selected set. A node that is
 * both inside a selected subtree and above another selected node
 * counts as `descendant` — being in focus wins, since its whole
 * subtree is already visible.
 */
export function computeSectionRelations(
  nodes: readonly TocNode[],
  selected: ReadonlySet<string>,
): Map<string, SectionRelation> {
  const relations = new Map<string, SectionRelation>();

  const visit = (node: TocNode, underSelected: boolean): boolean => {
    const isSelected = selected.has(node.id);
    let containsSelected = false;
    for (const child of node.children) {
      if (visit(child, underSelected || isSelected)) containsSelected = true;
    }
    relations.set(
      node.id,
      isSelected
        ? 'selected'
        : underSelected
          ? 'descendant'
          : containsSelected
            ? 'ancestor'
            : 'unrelated',
    );
    return containsSelected || isSelected;
  };

  for (const node of nodes) visit(node, false);
  return relations;
}

/**
 * Map every `data-block` / `data-subblock` id in the rendered article
 * to its enclosing heading-id chain (root → innermost), by walking the
 * DOM in document order with a heading stack. A heading's own block id
 * maps to a chain that includes the heading itself, matching the
 * renderer's `headingPath` convention. Blocks before the first heading
 * get an empty chain.
 *
 * `headingIds` restricts the stack to headings the TOC knows about, so
 * an id on user-authored raw HTML can't derail the section structure.
 */
export function collectBlockSectionIds(
  article: HTMLElement,
  headingIds: ReadonlySet<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const stack: Array<{ level: number; id: string }> = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    const headingMatch = /^H([1-6])$/.exec(el.tagName);
    if (headingMatch && el.id && headingIds.has(el.id)) {
      const level = Number(headingMatch[1]);
      for (let top = stack.at(-1); top && top.level >= level; top = stack.at(-1)) {
        stack.pop();
      }
      stack.push({ level, id: el.id });
    }

    const chain = () => stack.map((s) => s.id);
    const blockId = el.getAttribute('data-block');
    if (blockId) map.set(blockId, chain());
    const subBlockId = el.getAttribute('data-subblock');
    if (subBlockId) map.set(subBlockId, chain());
  }

  return map;
}

/** The two anchor fields section filtering cares about; `Thread['anchor']` satisfies it. */
export interface SectionAnchorRef {
  block_id: string | null;
  end_block_id?: string | null | undefined;
}

/**
 * Whether an anchor lands inside any selected section. Multi-block
 * spans count if either endpoint does. Anchors that resolve to no
 * known block (orphans) or to a chain outside every selected subtree
 * (preamble, other chapters) don't.
 */
export function anchorTouchesSections(
  anchor: SectionAnchorRef,
  blockSections: ReadonlyMap<string, readonly string[]>,
  selected: ReadonlySet<string>,
): boolean {
  const touches = (blockId: string | null | undefined): boolean => {
    if (!blockId) return false;
    return blockSections.get(blockId)?.some((id) => selected.has(id)) ?? false;
  };
  return touches(anchor.block_id) || touches(anchor.end_block_id);
}

export function threadTouchesSections(
  thread: { anchor: SectionAnchorRef },
  blockSections: ReadonlyMap<string, readonly string[]>,
  selected: ReadonlySet<string>,
): boolean {
  return anchorTouchesSections(thread.anchor, blockSections, selected);
}

/**
 * `data-section-filter="collapsed|expanded"` records that the filter —
 * not the reader — changed a wrapper's state, so clearing the filter
 * can put it back. Sections the reader had already collapsed get no
 * marker and stay collapsed after the filter clears.
 */
const FILTER_STATE_ATTR = 'data-section-filter';
const DIMMED_CLASS = 'section-filter-dimmed';

/**
 * Enforce the filter on the rendered document: unrelated sections are
 * held collapsed, ancestors of a selection are held open, and both get
 * their chevron disabled. Selected sections and their descendants stay
 * freely togglable. Pass `relations = null` to undo everything.
 *
 * `revealIds` names sections that should be expanded once (the ones
 * just added to the filter); that expansion is user-equivalent and
 * intentionally gets no restore marker.
 */
export function applySectionFilterToDocument(
  article: HTMLElement,
  relations: ReadonlyMap<string, SectionRelation> | null,
  revealIds?: ReadonlySet<string>,
): void {
  // Undo first so each apply starts from the reader's own state.
  for (const wrapper of article.querySelectorAll<HTMLElement>(`[${FILTER_STATE_ATTR}]`)) {
    const forced = wrapper.getAttribute(FILTER_STATE_ATTR);
    wrapper.removeAttribute(FILTER_STATE_ATTR);
    setSectionCollapsed(wrapper, forced === 'expanded');
  }
  for (const button of article.querySelectorAll<HTMLButtonElement>(
    '.heading-collapse-toggle[disabled]',
  )) {
    button.disabled = false;
  }
  for (const el of article.querySelectorAll<HTMLElement>(`.${DIMMED_CLASS}`)) {
    el.classList.remove(DIMMED_CLASS);
  }

  if (!relations) return;
  enforceSectionFilter(article, relations, revealIds);
}

/**
 * Enforce-only re-assert for when outside code (`expandAncestors` from
 * a deep link or thread jump) reopens a held-closed section: skips the
 * undo/restore sweep above, so only wrappers whose state actually
 * drifted get flipped (and dispatch events) — no double-flip of every
 * forced wrapper.
 */
export function reassertSectionFilterOnDocument(
  article: HTMLElement,
  relations: ReadonlyMap<string, SectionRelation>,
): void {
  enforceSectionFilter(article, relations);
}

/** Per-heading enforcement; idempotent, touches only state that is wrong. */
function enforceSectionFilter(
  article: HTMLElement,
  relations: ReadonlyMap<string, SectionRelation>,
  revealIds?: ReadonlySet<string>,
): void {
  for (const [id, relation] of relations) {
    if (relation === 'descendant') continue;
    const heading = article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!heading || !/^H[1-6]$/.test(heading.tagName)) continue;

    const sibling = heading.nextElementSibling;
    const wrapper =
      sibling instanceof HTMLElement && sibling.classList.contains('collapse-section')
        ? sibling
        : null;
    const toggle = heading.querySelector<HTMLButtonElement>(':scope > .heading-collapse-toggle');

    if (relation === 'selected') {
      if (wrapper && revealIds?.has(id) && wrapper.classList.contains('is-collapsed')) {
        setSectionCollapsed(wrapper, false);
      }
      continue;
    }

    if (relation === 'unrelated') heading.classList.add(DIMMED_CLASS);
    if (toggle) toggle.disabled = true;
    if (!wrapper) continue;

    const wantCollapsed = relation === 'unrelated';
    if (wrapper.classList.contains('is-collapsed') !== wantCollapsed) {
      wrapper.setAttribute(FILTER_STATE_ATTR, wantCollapsed ? 'collapsed' : 'expanded');
      setSectionCollapsed(wrapper, wantCollapsed);
    }
  }
}
