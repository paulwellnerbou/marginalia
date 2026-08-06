import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommentAnchor, DocumentFormat } from '../lib/api.js';
import { captureSelection, selectionRect } from '../lib/selection.js';

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
  blockRanges: Map<string, BlockSourceRange>;
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
 * Toolbar for a text selection inside the document pane — floating next
 * to the selection (mouse) or docked at the bottom of the pane (touch).
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
export function SelectionToolbar({ rootRef, docFormat, blockRanges, onAdd, onPropose }: Props) {
  const [state, setState] = useState<{
    rect: DOMRect;
    span: ResolvedSpan | null;
    docked: boolean;
  } | null>(null);

  // Whether the selection is being made by finger/pen rather than mouse.
  // Touch selections get the docked toolbar (see below). Seeded from the
  // primary-pointer media query so a tablet's first selection is docked
  // even before any pointerdown has been observed.
  const coarseInput = useRef(
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
  );

  useEffect(() => {
    const remember = (e: PointerEvent) => {
      coarseInput.current = e.pointerType === 'touch' || e.pointerType === 'pen';
    };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, []);

  useEffect(() => {
    const update = () => {
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
      const span = resolveSpan(root, range, docFormat, blockRanges);
      setState({ rect, span, docked: coarseInput.current });
    };
    // iOS WebKit (observed on 18.x) does not fire `selectionchange` for
    // long-press selections in non-editable content — only newer versions
    // do. Re-check after every touch/pointer release instead; the checks
    // are staggered because the selection finalizes asynchronously after
    // the finger lifts.
    let timers: number[] = [];
    const scheduleUpdate = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = [0, 150, 400].map((ms) => window.setTimeout(update, ms));
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerup', scheduleUpdate, true);
    document.addEventListener('pointercancel', scheduleUpdate, true);
    document.addEventListener('touchend', scheduleUpdate, true);
    document.addEventListener('touchcancel', scheduleUpdate, true);
    return () => {
      for (const t of timers) window.clearTimeout(t);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerup', scheduleUpdate, true);
      document.removeEventListener('pointercancel', scheduleUpdate, true);
      document.removeEventListener('touchend', scheduleUpdate, true);
      document.removeEventListener('touchcancel', scheduleUpdate, true);
    };
  }, [rootRef, docFormat, blockRanges]);

  if (!state) return null;

  function doComment(e: React.PointerEvent) {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const anchor = captureSelection(root);
    if (anchor) onAdd(anchor);
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  function doPropose(e: React.PointerEvent) {
    e.preventDefault();
    const root = rootRef.current;
    if (!root || !state) return;
    // Recompute from the live range: handle drags on iOS may not have
    // fired any event since the last update, leaving state.span stale.
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const span =
      range && root.contains(range.commonAncestorContainer)
        ? resolveSpan(root, range, docFormat, blockRanges)
        : state.span;
    if (!span) return;
    const blockText = span.textEls
      .map((el) => (el.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter((s) => s.length > 0)
      .join('\n\n');
    onPropose?.({
      block_id: span.startId,
      end_block_id: span.endId,
      block_text: blockText,
      block_count: span.blockCount,
    });
    setState(null);
    window.getSelection()?.removeAllRanges();
  }

  const proposeLabel =
    state.span && state.span.blockCount > 1
      ? `Propose edit (${state.span.blockCount} blocks)`
      : 'Propose edit';

  // Touch/pen: the native selection callout hugs the selection (above it
  // on iPadOS ≤18, below on 26) and paints over anything anchored there,
  // so dock the toolbar at the bottom of the doc pane instead. Mouse
  // selections keep the floating placement next to the selection.
  const clampX = (x: number) => Math.max(60, Math.min(window.innerWidth - 60, x));
  const rootRect = state.docked ? rootRef.current?.getBoundingClientRect() : undefined;
  const style: React.CSSProperties = state.docked
    ? { left: clampX(rootRect ? rootRect.left + rootRect.width / 2 : window.innerWidth / 2) }
    : {
        top: state.rect.top + window.scrollY - 40,
        left: clampX(state.rect.left + window.scrollX + state.rect.width / 2),
      };

  // Pointerdown, not click: it fires while the selection still exists.
  // A tap on iOS dismisses the selection on touchend, and the synthetic
  // mouse events arrive after that — with only mouse/click handlers the
  // toolbar is unmounted before they're delivered.
  const stopMouse = (e: React.MouseEvent) => e.preventDefault();
  // Portal to the theme root: the toolbar renders inside `.doc-scroll`,
  // whose `container-type` makes it the containing block for fixed
  // descendants on spec-following engines (observed on iOS 18 WebKit) —
  // `position: fixed` coordinates would resolve against the scroller's
  // content, not the viewport. The `.radix-themes` wrapper is
  // viewport-sized, uncontained, and still carries the color tokens.
  const portalTarget = rootRef.current?.closest('.radix-themes') ?? document.body;
  return createPortal(
    <div
      className={state.docked ? 'selection-toolbar is-docked' : 'selection-toolbar'}
      style={style}
    >
      <button type="button" onPointerDown={doComment} onMouseDown={stopMouse}>
        + Comment
      </button>
      {onPropose && state.span && (
        <button type="button" onPointerDown={doPropose} onMouseDown={stopMouse}>
          {proposeLabel}
        </button>
      )}
    </div>,
    portalTarget,
  );
}

/**
 * Resolve which block(s) the selection range covers.
 *
 *   - Exactly one sub-block touched → single-block proposal at the sub-block id.
 *   - Multiple sibling list-item sub-blocks of a top-level markdown
 *     list (their direct `<ul>`/`<ol>` parent carries `[data-block]`)
 *     → multi-block proposal spanning the first/last list-item ids.
 *     Items in nested lists, lists inside blockquotes, or asciidoc
 *     lists don't qualify — splicing across their bullets would
 *     drop the indent/`>` prefix or hit best-effort source ranges,
 *     so we fall through to collapse-to-parent.
 *   - Multiple table-cell sub-blocks sharing one `<table>` parent →
 *     single-block proposal at the table id. Cell-level multi-block
 *     would slice across `|` pipes and corrupt the table.
 *   - Sub-blocks whose enclosing top-level container has no
 *     `[data-block]` (e.g. an asciidoc list whose synthesized parent
 *     wasn't recorded) → single-block proposal on the first touched
 *     sub-block, so "Propose edit" stays available.
 *   - One top-level block touched (no sub-blocks involved) → single-block.
 *   - Anything else → multi-block: startId/endId are the first/last
 *     top-level block in DOM order.
 */
function resolveSpan(
  root: HTMLElement,
  range: Range,
  docFormat: DocumentFormat,
  blockRanges: Map<string, BlockSourceRange>,
): ResolvedSpan | null {
  // Narrow the search to the selection's common ancestor subtree —
  // `selectionchange` fires on every keystroke / drag tick, and a full
  // `root.querySelectorAll` over a large document would be wasteful.
  // Then walk back up to `root` so we still consider any wrapping
  // top-level block the selection sits inside (e.g. cursor in one cell
  // → only the table is an ancestor of commonAncestor).
  const selector = '[data-block], [data-subblock]';
  const ca = range.commonAncestorContainer;
  const scope = (ca.nodeType === Node.ELEMENT_NODE ? (ca as Element) : ca.parentElement) ?? root;
  const inScope = scope instanceof HTMLElement && root.contains(scope) ? scope : root;

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
  const subBlocksOnly = touched.every((el) => !!el.dataset.subblock && !el.dataset.block);
  if (subBlocksOnly) {
    if (touched.length === 1) {
      const only = touched[0]!;
      const id = only.dataset.subblock!;
      return { startId: id, endId: null, textEls: [only], blockCount: 1 };
    }
    // List items splice cleanly as a multi-block range in markdown
    // only when the validator (`canMergeMultiBlock`) would accept the
    // pair. We check directly against the block-range map so the UI
    // doesn't propose splices the server then rejects:
    //
    //   1. Both items must be siblings at the same list level (same
    //      direct parent `<ul>`/`<ol>`). Otherwise an
    //      inner-bullet→outer-sibling span crosses the outer item's
    //      closing.
    //   2. Both items' resolved `BlockSourceRange.parentStart` must
    //      be defined and equal. The locator only sets `parentStart`
    //      for items in lists that begin at column 1 (offset 0 or
    //      preceded by `\n`); indented or blockquoted lists leave it
    //      unset, so this check naturally excludes them.
    //
    // The earlier `directParent.dataset.block` heuristic was close
    // but not exact — a markdown list indented 1–3 spaces is still a
    // top-level mdast node and gets `data-block`, yet its items lack
    // `parentStart`. Going through `blockRanges` gives the same rule
    // the validator uses.
    const directParent = touched[0]?.parentElement;
    const firstParentStart =
      docFormat === 'markdown' &&
      touched.length > 0 &&
      touched.every((el) => el.tagName === 'LI') &&
      touched.every((el) => el.parentElement === directParent)
        ? blockRanges.get(touched[0]!.dataset.subblock ?? '')?.parentStart
        : undefined;
    const allSiblingListItems =
      firstParentStart !== undefined &&
      touched.every(
        (el) => blockRanges.get(el.dataset.subblock ?? '')?.parentStart === firstParentStart,
      );
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
  const startsBeforeElEnd = range.compareBoundaryPoints(Range.END_TO_START, elRange) < 0;
  const endsAfterElStart = range.compareBoundaryPoints(Range.START_TO_END, elRange) > 0;
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
