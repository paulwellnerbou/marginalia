import { useEffect, useState } from 'react';
import { captureSelection, selectionRect } from '../lib/selection.js';
import type { CommentAnchor, DocumentFormat } from '../lib/api.js';

export interface ProposalTarget {
  block_id: string;
  /**
   * Multi-block proposal: id of the last top-level block in the span
   * (in source/DOM order). Null/absent for single-block proposals.
   */
  end_block_id?: string | null;
  /** Normalized plain text of the whole span, used as the quote snapshot. */
  block_text: string;
  /** Number of top-level blocks the span covers. 1 for single-block. */
  block_count: number;
}

interface Props {
  rootRef: React.RefObject<HTMLElement | null>;
  docFormat: DocumentFormat;
  onAdd: (anchor: CommentAnchor) => void;
  onPropose?: (target: ProposalTarget) => void;
}

interface ResolvedSpan {
  startId: string;
  endId: string | null;
  /** Elements whose text contributes to `block_text`, in DOM order. */
  textEls: HTMLElement[];
  blockCount: number;
}

/**
 * Floating toolbar next to a text selection inside the document pane.
 * "+ Comment" captures the exact selection span. "Propose edit" expands
 * to the nearest proposal-targetable block — a top-level block
 * (paragraph, heading, code block, blockquote, list, table, …) OR a
 * sub-block (list item, table cell) when the selection is inside one.
 *
 * Multi-block selections collapse first: if all touched sub-blocks
 * share a single `[data-block]` ancestor, the proposal targets that
 * parent (the whole list / whole table). Otherwise, when the selection
 * spans multiple distinct top-level blocks, the proposal carries
 * `block_id` plus optional `end_block_id` so the server can splice the
 * entire range.
 */
export function SelectionToolbar({ rootRef, docFormat, onAdd, onPropose }: Props) {
  const [state, setState] = useState<{ rect: DOMRect; span: ResolvedSpan | null } | null>(null);

  useEffect(() => {
    const handle = () => {
      const root = rootRef.current;
      if (!root) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setState(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setState(null);
        return;
      }
      const rect = selectionRect();
      if (!rect) {
        setState(null);
        return;
      }
      const span = resolveSpan(root, range, docFormat);
      setState({ rect, span });
    };
    document.addEventListener('selectionchange', handle);
    return () => document.removeEventListener('selectionchange', handle);
  }, [rootRef, docFormat]);

  if (!state) return null;

  function doComment(e: React.MouseEvent) {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const anchor = captureSelection(root);
    if (anchor) onAdd(anchor);
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  function doPropose(e: React.MouseEvent) {
    e.preventDefault();
    if (!state || !state.span) return;
    const blockText = state.span.textEls
      .map((el) => (el.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter((s) => s.length > 0)
      .join('\n\n');
    onPropose?.({
      block_id: state.span.startId,
      end_block_id: state.span.endId,
      block_text: blockText,
      block_count: state.span.blockCount,
    });
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  const proposeLabel =
    state.span && state.span.blockCount > 1
      ? `Propose edit (${state.span.blockCount} blocks)`
      : 'Propose edit';

  return (
    <div
      className="selection-toolbar"
      style={{
        top: state.rect.top + window.scrollY - 40,
        left: Math.max(
          60,
          Math.min(
            window.innerWidth - 60,
            state.rect.left + window.scrollX + state.rect.width / 2,
          ),
        ),
      }}
    >
      {/* mousedown so the handler fires before selectionchange clears the range */}
      <button type="button" onMouseDown={doComment}>+ Comment</button>
      {onPropose && state.span && (
        <button type="button" onMouseDown={doPropose}>{proposeLabel}</button>
      )}
    </div>
  );
}

/**
 * Resolve which block(s) the selection range covers.
 *
 *   - Exactly one sub-block touched → single-block proposal at the sub-block id.
 *   - Multiple list-item sub-blocks (markdown only) → multi-block
 *     proposal spanning the first/last list-item ids. Markdown
 *     list-item ranges are line-aligned, so a span splices cleanly
 *     across items. For asciidoc we instead collapse to the parent
 *     list — `locateAllBlocksAsciidoc` derives item ranges
 *     best-effort and doesn't yet cover continuation (`+`) lines, so
 *     a multi-listItem splice would truncate items with continuations.
 *   - Multiple table-cell sub-blocks sharing one `<table>` parent →
 *     single-block proposal at the table id. Cell-level multi-block
 *     would slice across `|` pipes and corrupt the table.
 *   - One top-level block touched (no sub-blocks involved) → single-block.
 *   - Anything else → multi-block: startId/endId are the first/last
 *     top-level block in DOM order.
 */
function resolveSpan(
  root: HTMLElement,
  range: Range,
  docFormat: DocumentFormat,
): ResolvedSpan | null {
  // Narrow the search to the selection's common ancestor subtree —
  // `selectionchange` fires on every keystroke / drag tick, and a full
  // `root.querySelectorAll` over a large document would be wasteful.
  // Then walk back up to `root` so we still consider any wrapping
  // top-level block the selection sits inside (e.g. cursor in one cell
  // → only the table is an ancestor of commonAncestor).
  const selector = '[data-block], [data-subblock]';
  const ca = range.commonAncestorContainer;
  const scope =
    (ca.nodeType === Node.ELEMENT_NODE ? (ca as Element) : ca.parentElement) ?? root;
  const inScope =
    scope instanceof HTMLElement && root.contains(scope) ? scope : root;

  const all: HTMLElement[] = [];
  if (inScope instanceof HTMLElement && inScope.matches(selector)) all.push(inScope);
  all.push(...inScope.querySelectorAll<HTMLElement>(selector));
  let ancestor: HTMLElement | null = inScope.parentElement;
  while (ancestor && ancestor !== root) {
    if (ancestor.matches(selector)) all.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  if (root !== inScope && root.matches(selector)) all.push(root);

  let touched = all.filter((el) => intersectsRange(range, el));

  // `all` is built from `inScope.querySelectorAll(...)` (preorder)
  // *plus* matching ancestors walked outward to `root`, so descendants
  // can come before their ancestors. The stack-based prune below
  // assumes DOM preorder (parents before descendants) — sort first so
  // a selection inside a cell doesn't keep both the `<td>` AND the
  // enclosing `<table>`.
  touched.sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // Drop ancestors whose descendants are also touched. A selection
  // inside one table cell intersects both the `<td data-subblock>` and
  // the enclosing `<table data-block>`; we want to act on the
  // innermost — the cell — not the whole table.
  //
  // After the sort above, `touched` is in preorder. A linear stack
  // pass keeps only the innermost touched elements: when the new
  // element is contained by the stack's top, pop the top (the
  // ancestor is subsumed); otherwise push and move on. O(n) instead
  // of the previous O(n²) `some(contains)` filter.
  const pruned: HTMLElement[] = [];
  for (const el of touched) {
    while (pruned.length > 0 && pruned[pruned.length - 1]!.contains(el)) {
      pruned.pop();
    }
    pruned.push(el);
  }
  touched = pruned;

  // Triple-click / keyboard-extend selections often end at offset 0 of
  // the *next* block; drop a trailing block that's only "touched"
  // because the caret sits at its very start.
  if (touched.length > 1) {
    const last = touched[touched.length - 1]!;
    if (
      range.endOffset === 0 &&
      (range.endContainer === last || last.contains(range.endContainer))
    ) {
      touched = touched.slice(0, -1);
    }
  }

  if (touched.length === 0) {
    // Fallback to the previous behavior: nearest block ancestor of the
    // selection's start. Triple-click on a paragraph sets
    // commonAncestorContainer to the parent, so this keeps that working.
    const nearest =
      closestBlock(range.commonAncestorContainer) ?? closestBlock(range.startContainer);
    if (!nearest) return null;
    const id = nearest.dataset.subblock ?? nearest.dataset.block ?? null;
    if (!id) return null;
    return { startId: id, endId: null, textEls: [nearest], blockCount: 1 };
  }

  // Sub-block-only selection.
  const subBlocksOnly = touched.every(
    (el) => !!el.dataset.subblock && !el.dataset.block,
  );
  if (subBlocksOnly) {
    if (touched.length === 1) {
      const only = touched[0]!;
      const id = only.dataset.subblock!;
      return { startId: id, endId: null, textEls: [only], blockCount: 1 };
    }
    // List items splice cleanly as a multi-block range in markdown
    // (line-aligned source). Emit first→last list-item ids so the user
    // can edit a subset of items without dragging the whole list along.
    // Asciidoc skips this branch — see the resolveSpan doc comment.
    //
    // Constraint: all touched `<li>`s must be siblings at the *same*
    // list level (same direct parent `<ul>`/`<ol>`). Without this, a
    // selection that starts in an outer item and crosses into a nested
    // sublist gets pruned down to the nested child + a later outer
    // sibling, producing a span that starts at the inner bullet and
    // crosses the outer item's closing — corrupting structure on
    // splice. Mixed-level selections fall through to the collapse path.
    const allSiblingListItems =
      docFormat === 'markdown' &&
      touched.every((el) => el.tagName === 'LI') &&
      touched.every((el) => el.parentElement === touched[0]!.parentElement);
    if (allSiblingListItems) {
      const first = touched[0]!;
      const last = touched[touched.length - 1]!;
      return {
        startId: first.dataset.subblock!,
        endId: last.dataset.subblock!,
        textEls: touched,
        blockCount: touched.length,
      };
    }
    // Table cells: collapse to the shared `<table>` parent. A
    // cell-level multi-block span would slice across `|` pipes.
    const sharedParent = sharedTopLevelAncestor(touched);
    if (sharedParent && sharedParent.dataset.block) {
      return {
        startId: sharedParent.dataset.block,
        endId: null,
        textEls: [sharedParent],
        blockCount: 1,
      };
    }
    // Different parents (e.g. cells from different tables): fall
    // through to multi-block on the parents.
    const parents = uniqueOrdered(
      touched.map((el) => topLevelAncestor(el)).filter((el): el is HTMLElement => el !== null),
    );
    if (parents.length === 0) {
      // No `[data-block]` ancestor exists for any touched sub-block
      // (e.g. an asciidoc list whose enclosing `<ul>` had no
      // extractable text and so wasn't recorded as a top-level block).
      // Fall back to a single-block proposal on the first touched
      // sub-block — better than hiding "Propose edit" entirely.
      const only = touched[0]!;
      const id = only.dataset.subblock;
      if (!id) return null;
      return { startId: id, endId: null, textEls: [only], blockCount: 1 };
    }
    const first = parents[0]!;
    const lastP = parents[parents.length - 1]!;
    if (parents.length === 1) {
      return {
        startId: first.dataset.block!,
        endId: null,
        textEls: [first],
        blockCount: 1,
      };
    }
    return {
      startId: first.dataset.block!,
      endId: lastP.dataset.block!,
      textEls: parents,
      blockCount: parents.length,
    };
  }

  // Mixed or top-level: collapse each touched element to its top-level
  // block (a top-level data-block element returns itself), then dedupe.
  const tops = uniqueOrdered(
    touched.map((el) => topLevelAncestor(el)).filter((el): el is HTMLElement => el !== null),
  );
  if (tops.length === 0) return null;
  const firstTop = tops[0]!;
  const lastTop = tops[tops.length - 1]!;
  if (tops.length === 1) {
    return { startId: firstTop.dataset.block!, endId: null, textEls: [firstTop], blockCount: 1 };
  }
  return {
    startId: firstTop.dataset.block!,
    endId: lastTop.dataset.block!,
    textEls: tops,
    blockCount: tops.length,
  };
}

function intersectsRange(range: Range, el: HTMLElement): boolean {
  // Range.intersectsNode is a non-standard but widely supported helper;
  // fall back to manual comparison if missing.
  if (typeof range.intersectsNode === 'function') return range.intersectsNode(el);
  // Standard overlap test: range.start < el.end AND range.end > el.start.
  // `compareBoundaryPoints(END_TO_START, other)` compares this.start to
  // other.end; `START_TO_END` compares this.end to other.start.
  // Returns -1 / 0 / +1 for before / equal / after, so strict inequality
  // matches Range.intersectsNode (touching boundaries don't count).
  const elRange = el.ownerDocument!.createRange();
  elRange.selectNodeContents(el);
  const startsBeforeElEnd =
    range.compareBoundaryPoints(Range.END_TO_START, elRange) < 0;
  const endsAfterElStart =
    range.compareBoundaryPoints(Range.START_TO_END, elRange) > 0;
  return startsBeforeElEnd && endsAfterElStart;
}

function topLevelAncestor(el: HTMLElement): HTMLElement | null {
  // Walk upward looking for a [data-block] element. A sub-block-only
  // node returns the enclosing top-level block; a top-level node
  // returns itself.
  let n: HTMLElement | null = el;
  while (n) {
    if (n.dataset.block) return n;
    n = n.parentElement;
  }
  return null;
}

function sharedTopLevelAncestor(els: HTMLElement[]): HTMLElement | null {
  if (els.length === 0) return null;
  const first = topLevelAncestor(els[0]!);
  if (!first) return null;
  for (let i = 1; i < els.length; i++) {
    if (topLevelAncestor(els[i]!) !== first) return null;
  }
  return first;
}

function uniqueOrdered<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function closestBlock(node: Node): HTMLElement | null {
  // Returns the nearest proposal-targetable ancestor — either a top-level
  // block (`data-block`) or a fine-grained sub-block (`data-subblock`
  // on list items / table cells).
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && (n.dataset.subblock || n.dataset.block)) return n;
    n = n.parentNode;
  }
  return null;
}
