import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import type { CommentAnchor, Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';
import {
  buildThreadCollapseState,
  reconcileThreadCollapseState,
  type ThreadCollapseState,
} from '../threadCollapseState.js';
import { InlineCommentsToolbar } from './InlineCommentsToolbar.js';
import { InlineComposer } from './InlineComposer.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import {
  COMMENT_FLASH_MS,
  type ThreadActionResult,
  threadLinks,
  threadsById,
} from './inlineUtils.js';
import { computeAnchoredThreadNesting, nestedThreadsOf } from './threadNesting.js';
import { type ThreadRefApi, threadRefIndex } from './threadRefs.js';

interface Props {
  uid: string;
  /** Already filtered for visibility by the layout — every thread here gets a card. */
  threads: Thread[];
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  blockRanges: Map<string, BlockSourceRange>;
  canComment: boolean;
  open: boolean;
  onToggleOpen: () => void;
  /**
   * When true: all cards are sticky-stacked at the top initially. As
   * scroll reaches each card's anchor in turn, all currently-stacked
   * cards unstick and scroll with the doc together; once the lead card
   * fully leaves the viewport, the remaining cards re-engage as a
   * stack from the top. This repeats for cards 2, 3, ...
   *
   * When false: cards sit at their anchors and scroll with the doc;
   * no sticky behaviour.
   */
  stackingEnabled: boolean;
  onToggleStacking: () => void;
  /** State of the "Show resolved" switch in the column's toolbar; the
   *  filtering itself happens upstream, in the layout. */
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  /** Switch the comment presentation from the margin column to floating cards. */
  onSwitchToFloating: () => void;
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number; scroll: boolean } | null;
  displayName: string | null;
  mentionCandidates: string[];
  onCancelPending: () => void;
  onCreate: (payload: {
    anchor: CommentAnchor;
    body: string;
    display_name?: string;
  }) => Promise<void>;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onSetHidden: (id: string, hidden: boolean) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<ThreadActionResult>;
  onRepairThread: (id: string) => Promise<ThreadActionResult>;
  onResolveConflict: (
    id: string,
    payload: { resolvedText?: string; comment?: string },
  ) => Promise<ThreadActionResult>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onCreateProposal?: ((thread: Thread) => void) | undefined;
  onEditProposal?: ((thread: Thread) => void) | undefined;
  onScrollToAnchor: (
    blockId: string,
    quote?: string | null,
    threadId?: string,
    scrollOffset?: number,
  ) => void;
}

interface OrderItem {
  thread: Thread;
  blockIndex: number;
  startOffset: number;
  createdAt: number;
}

interface RenderItem {
  id: string;
  blockId: string | null;
  quote?: string | null;
}

const PENDING_ID = '__pending__';
const STACK_GAP_PX = 8;
/**
 * Base offset above each sticky card: the toolbar's own CSS `top`
 * (8px, see `.ic-toolbar` in app.css) plus a `STACK_GAP_PX` gap below
 * it so the spacing between the toolbar and the first card matches
 * the spacing between cards. The effective sticky-top pad is this
 * base plus the measured toolbar height (computed inside the
 * component as `stickyTopPad`).
 */
const TOOLBAR_TOP_OFFSET_PX = 8;
const TOOLBAR_BASE_TOP_PAD_PX = TOOLBAR_TOP_OFFSET_PX + STACK_GAP_PX;
const FOCUS_MS = 1800;
const DEFAULT_OPEN_COLUMN_WIDTH_PX = 280;
const MIN_OPEN_COLUMN_WIDTH_PX = 240;
const COLUMN_WIDTH_TRANSITION_MS = 180;
const COLUMN_WIDTH_TRANSITION_FALLBACK_MS = COLUMN_WIDTH_TRANSITION_MS + 80;

/**
 * Global state shared by all cards.
 *
 * `epoch` = number of cards that have already passed their anchor and
 * scrolled fully out of view. Cards [0..epoch-1] are landed at their
 * own anchors; cards [epoch..N-1] are the "current stack."
 *
 * `isSticky` = whether the current stack is in its sticky phase
 * (pinned at the viewport top in document order) or its scrolling
 * phase (riding the document with their stacked offsets after the
 * lead card's anchor was reached but before it fully left the
 * viewport).
 */
interface GlobalState {
  epoch: number;
  isSticky: boolean;
}

export function InlineCommentsLayer({
  uid,
  threads,
  docHtml,
  docElementRef,
  scrollContainerRef,
  blockRanges,
  canComment,
  open,
  onToggleOpen,
  stackingEnabled,
  onToggleStacking,
  hideResolved,
  onToggleHideResolved,
  onSwitchToFloating,
  pendingAnchor,
  focusedThread,
  displayName,
  mentionCandidates,
  onCancelPending,
  onCreate,
  onReply,
  onEdit,
  onSetHidden,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onResolveConflict,
  onReact,
  onCreateProposal,
  onEditProposal,
  onScrollToAnchor,
}: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const [openColumnWidth, setOpenColumnWidth] = useState(DEFAULT_OPEN_COLUMN_WIDTH_PX);
  const stickyTopPad = TOOLBAR_BASE_TOP_PAD_PX + toolbarHeight;

  const byId = useMemo(() => threadsById(threads), [threads]);

  /**
   * Merge each proposal into the card of the thread it answers. Only
   * top-level threads get their own anchored card; nested proposals
   * render inside the parent's card. Computed over the threads the
   * layout already filtered, so a proposal whose answered thread is
   * hidden (resolved + hide-resolved) keeps its own card.
   */
  const nesting = useMemo(() => computeAnchoredThreadNesting(threads), [threads]);

  /**
   * Auto-collapse defaults derived from the current thread list.
   * Threads start collapsed when they're already resolved or accepted/
   * rejected proposals. The shared reconciler tracks "auto-collapse
   * just activated" so a thread the user manually expanded doesn't
   * snap back to collapsed when something else triggers a re-render.
   */
  const collapseDefaults = useMemo(
    () =>
      threads.map((t) => ({
        id: t.id,
        autoCollapse: shouldAutoCollapse(t),
      })),
    [threads],
  );
  const [collapseState, setCollapseState] = useState<ThreadCollapseState>(() =>
    buildThreadCollapseState(collapseDefaults),
  );
  const collapsed = collapseState.collapsed;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);
  // Seeded with the current nonce so remounting (display-mode toggle)
  // doesn't replay a focus signal that was already handled.
  const lastNonce = useRef<number | null>(focusedThread?.nonce ?? null);

  useEffect(() => {
    setCollapseState((prev) => reconcileThreadCollapseState(prev, collapseDefaults));
  }, [collapseDefaults]);

  /**
   * Document-order rank for each block id. `blockRanges`'s iteration
   * order puts top-level blocks first and sub-blocks afterwards, so a
   * thread anchored to a sub-block would otherwise sort after every
   * top-level block — breaking the monotonic-anchors assumption the
   * sticky/epoch state machine relies on. Sort by source offset
   * instead so list-item-anchored threads land in the right place.
   */
  const blockOrder = useMemo(() => {
    const ranked = Array.from(blockRanges.entries()).sort(([, a], [, b]) => a.start - b.start);
    const order = new Map<string, number>();
    let i = 0;
    for (const [id] of ranked) order.set(id, i++);
    return order;
  }, [blockRanges]);

  const sorted = useMemo<OrderItem[]>(() => {
    const items: OrderItem[] = nesting.topLevel.map((t) => ({
      thread: t,
      blockIndex: t.anchor.block_id
        ? (blockOrder.get(t.anchor.block_id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
      startOffset: isProposal(t) ? 0 : (t.anchor.start_offset ?? 0),
      createdAt: t.comments[0].created_at,
    }));
    items.sort(
      (a, b) =>
        a.blockIndex - b.blockIndex || a.startOffset - b.startOffset || a.createdAt - b.createdAt,
    );
    return items;
  }, [nesting, blockOrder]);

  /** Stable identity, so the toolbar's measured landing positions
   *  survive renders that leave the thread list alone — it re-measures
   *  whenever this array changes. */
  const sortedThreads = useMemo(() => sorted.map((s) => s.thread), [sorted]);

  /** O(1) lookup of thread by id — avoids `sorted.find(...)` per render in renderCardById. */
  const sortedById = useMemo<Map<string, OrderItem>>(() => {
    const map = new Map<string, OrderItem>();
    for (const item of sorted) map.set(item.thread.id, item);
    return map;
  }, [sorted]);

  /**
   * Render order — same document ordering as `sorted`, plus the
   * pending composer (if any) inserted at its anchor's position.
   * The sticky/epoch state machine assumes monotonically increasing
   * anchors, so a pending composer with an earlier anchor than some
   * existing thread MUST go in front of those threads or the epoch
   * transitions misfire.
   */
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = sorted.map((s) => ({
      id: s.thread.id,
      blockId: s.thread.anchor.block_id,
      quote: s.thread.anchor.quote,
    }));
    if (canComment && pendingAnchor) {
      const pendingBlockIndex = pendingAnchor.block_id
        ? (blockOrder.get(pendingAnchor.block_id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      const pendingStartOffset = pendingAnchor.start_offset ?? 0;
      const insertAt = sorted.findIndex(
        (s) =>
          pendingBlockIndex < s.blockIndex ||
          (pendingBlockIndex === s.blockIndex && pendingStartOffset < s.startOffset),
      );
      const pendingItem: RenderItem = {
        id: PENDING_ID,
        blockId: pendingAnchor.block_id,
        quote: pendingAnchor.quote,
      };
      if (insertAt === -1) items.push(pendingItem);
      else items.splice(insertAt, 0, pendingItem);
    }
    return items;
  }, [sorted, canComment, pendingAnchor, blockOrder]);

  /**
   * The thread most recently navigated to (toolbar arrows, card jump
   * buttons, ref links). The toolbar steps next/prev from here when the
   * viewport is still at that thread's position — scroll position alone
   * can't tell apart threads anchored to the same text.
   */
  const lastNavThreadRef = useRef<string | null>(null);

  /**
   * When stacking is disabled, cards sit at their natural anchor
   * positions (no stickyTopPad offset). Wrap onScrollToAnchor to
   * inject the stickyTopPad so the scrolled-to text appears with
   * the same clearance below the toolbar as in stacking mode.
   */
  const scrollToAnchorWithOffset = useCallback(
    (blockId: string, quote?: string | null, threadId?: string) => {
      if (threadId) lastNavThreadRef.current = threadId;
      onScrollToAnchor(blockId, quote, threadId, stackingEnabled ? 0 : stickyTopPad);
    },
    [onScrollToAnchor, stackingEnabled, stickyTopPad],
  );
  /** Jump to a linked thread by scrolling to its anchor, which focuses it. */
  const focusLinked = useCallback(
    (target: Thread) => {
      const blockId = target.anchor.block_id;
      if (blockId) scrollToAnchorWithOffset(blockId, target.anchor.quote, target.id);
    },
    [scrollToAnchorWithOffset],
  );

  const threadRefs = useMemo<ThreadRefApi>(() => {
    const index = threadRefIndex(threads);
    return { resolve: (id) => index.get(id) ?? null, focus: focusLinked };
  }, [threads, focusLinked]);

  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const naturalTops = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const hasTrackedColumnOpen = useRef(false);
  const columnWidthTransitioning = useRef(false);

  const [layoutVersion, setLayoutVersion] = useState(0);
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [globalState, setGlobalState] = useState<GlobalState>({ epoch: 0, isSticky: true });
  /**
   * The scroller's visible band, in the same content coordinates the
   * card tops use. Only the pending composer reads it (see the render
   * pass), so it is refreshed on every scroll while a draft is open
   * and left alone otherwise — a per-frame re-render of the whole
   * column is worth it for one transient card, not for the rest.
   */
  const [viewport, setViewport] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  const requestRemeasure = useCallback(() => {
    setLayoutVersion((n) => n + 1);
  }, []);

  const syncViewport = useCallback(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const top = scroll.scrollTop;
    const height = scroll.clientHeight;
    setViewport((prev) =>
      Math.abs(prev.top - top) < 0.5 && Math.abs(prev.height - height) < 0.5
        ? prev
        : { top, height },
    );
  }, [scrollContainerRef]);

  /** Anchors and heights as flat arrays in render order (for the state machine). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion is the explicit re-measure trigger; the body reads ref.current values that aren't reactive.
  const orderedMetrics = useMemo(() => {
    const anchors: number[] = [];
    const heights: number[] = [];
    for (const item of renderItems) {
      anchors.push(naturalTops.current.get(item.id) ?? 0);
      heights.push(cardHeights.current.get(item.id) ?? 96);
    }
    return { anchors, heights };
  }, [renderItems, layoutVersion]);

  /**
   * Stack offset for card_k inside the stack of cards [epoch..N-1].
   * The lead card (k === epoch) sits at `stickyTopPad` so it doesn't
   * touch the toolbar's bottom border; subsequent cards stack below
   * with the gap between them.
   */
  /**
   * Prefix sums of (cardHeight + gap) so stackOffset() is O(1) per
   * call. `stackPrefix[i]` = sum of `(heights[0..i-1] + STACK_GAP_PX)`.
   * The render pass calls stackOffset() once per card, and without
   * this precomputation that loop becomes O(N²) in thread count —
   * cheap for a few cards, noticeable on long docs.
   */
  const stackPrefix = useMemo(() => {
    const heights = orderedMetrics.heights;
    const arr = new Array<number>(heights.length + 1);
    arr[0] = 0;
    for (let i = 0; i < heights.length; i++) {
      arr[i + 1] = (arr[i] ?? 0) + (heights[i] ?? 96) + STACK_GAP_PX;
    }
    return arr;
  }, [orderedMetrics]);

  const stackOffset = useCallback(
    (k: number, epoch: number): number => {
      if (k < epoch) return 0;
      return stickyTopPad + (stackPrefix[k] ?? 0) - (stackPrefix[epoch] ?? 0);
    },
    [stackPrefix, stickyTopPad],
  );

  /**
   * Non-stacking layout: walk cards in document order and push each
   * one down to the max of its anchor and the previous card's bottom
   * (plus the gap), so two cards anchored close together never
   * visually overlap. Used only when `stackingEnabled === false`.
   */
  const noStackLayout = useMemo(() => {
    const tops: number[] = [];
    let prevBottom = stickyTopPad - STACK_GAP_PX;
    for (let k = 0; k < orderedMetrics.anchors.length; k++) {
      const natural = orderedMetrics.anchors[k] ?? 0;
      const h = orderedMetrics.heights[k] ?? 96;
      const top = Math.max(natural, prevBottom + STACK_GAP_PX);
      tops.push(top);
      prevBottom = top + h;
    }
    return { tops, totalHeight: prevBottom };
  }, [orderedMetrics, stickyTopPad]);

  /**
   * Walk through the global lifecycle to find the current
   * (epoch, isSticky) for the given scrollTop.
   *
   *   while there are still cards in the current stack:
   *     if scrollTop hasn't reached anchor[epoch] → STACKED at this epoch
   *     elif scrollTop is in the (h_epoch + gap) "scrolling" window after
   *          anchor[epoch] → SCROLLING at this epoch
   *     else                  → epoch + 1, repeat
   */
  const computeGlobalState = useCallback(
    (scrollTop: number): GlobalState => {
      const { anchors, heights } = orderedMetrics;
      const N = anchors.length;
      let e = 0;
      while (e < N) {
        const a_e = anchors[e] ?? 0;
        if (scrollTop < a_e) return { epoch: e, isSticky: true };
        const leaveAt = a_e + (heights[e] ?? 96) + STACK_GAP_PX;
        if (scrollTop < leaveAt) return { epoch: e, isSticky: false };
        e++;
      }
      return { epoch: N, isSticky: true };
    },
    [orderedMetrics],
  );

  const recomputeGlobalState = useCallback(() => {
    // The non-stacking branch of the layout pass ignores `globalState`
    // entirely (cards just sit at their anchors), so don't churn React
    // with epoch/isSticky transitions while scrolling.
    if (!stackingEnabled) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const next = computeGlobalState(scroll.scrollTop);
    setGlobalState((prev) =>
      prev.epoch === next.epoch && prev.isSticky === next.isSticky ? prev : next,
    );
  }, [computeGlobalState, scrollContainerRef, stackingEnabled]);

  /**
   * Re-measure each card's anchor position from the rendered doc.
   *
   * Returns true if any anchor changed (or an entry was added or
   * removed). Callers can use this to decide whether to bump
   * `layoutVersion` so the orderedMetrics memo re-derives — without
   * the bump, refs can update but the memoized derivative stays
   * stale until something else triggers a rerender.
   */
  const measureNaturalTops = useCallback((): boolean => {
    const doc = docElementRef.current;
    const scroll = scrollContainerRef.current;
    if (!doc || !scroll) return false;
    const scrollRect = scroll.getBoundingClientRect();
    const scrollTop = scroll.scrollTop;
    // First pass: anchored items get their measured natural top.
    // Track which items have no resolvable anchor so we can place
    // them after everything else (otherwise multiple null-anchor
    // items all measure to top:0 and overlap).
    let maxBottom = 0;
    let changed = false;
    const unanchored: { id: string; height: number }[] = [];
    for (const item of renderItems) {
      const cardHeight = cardHeights.current.get(item.id) ?? 96;
      let nat: number | null = null;
      if (item.blockId) {
        // Resolved the same way a jump to this thread resolves its
        // target: a quote starting partway down a long paragraph sits
        // well below the block's top, and anchoring the card to the
        // block instead would leave it that far above the highlight the
        // jump just parked at the top edge — clipped by the toolbar.
        const el = resolveThreadScrollTarget(doc, item.blockId, item.quote, item.id);
        if (el) {
          nat = el.getBoundingClientRect().top - scrollRect.top + scrollTop;
        }
      }
      if (nat === null) {
        unanchored.push({ id: item.id, height: cardHeight });
        continue;
      }
      const prev = naturalTops.current.get(item.id);
      if (prev === undefined || Math.abs(prev - nat) > 0.5) {
        naturalTops.current.set(item.id, nat);
        changed = true;
      }
      // Keep bottom measurement aligned with the render pass: stacked
      // cards land at nat + stickyTopPad, while non-stacking cards
      // render directly at nat.
      const cardBottom = nat + (stackingEnabled ? stickyTopPad : 0) + cardHeight;
      if (cardBottom > maxBottom) maxBottom = cardBottom;
    }
    // Second pass: stack any unanchored / orphaned items beneath the
    // last anchored card in document order, so they don't all collide
    // at scroll-y=0 with each other or with anchored content.
    let orphanY = maxBottom + STACK_GAP_PX;
    for (const { id, height } of unanchored) {
      const prev = naturalTops.current.get(id);
      if (prev === undefined || Math.abs(prev - orphanY) > 0.5) {
        naturalTops.current.set(id, orphanY);
        changed = true;
      }
      orphanY += height + STACK_GAP_PX;
      if (orphanY > maxBottom) maxBottom = orphanY;
    }
    const live = new Set(renderItems.map((i) => i.id));
    for (const id of Array.from(naturalTops.current.keys())) {
      if (!live.has(id)) {
        naturalTops.current.delete(id);
        cardHeights.current.delete(id);
        changed = true;
      }
    }
    setColumnHeight((prev) => (Math.abs(prev - maxBottom) > 0.5 ? maxBottom : prev));
    return changed;
  }, [renderItems, docElementRef, scrollContainerRef, stackingEnabled, stickyTopPad]);

  // Stable per-id ref callbacks — see the prior sticky-overlay version
  // for why inline arrows would re-attach every render.
  const refCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const getRefCallback = useCallback((id: string) => {
    let cb = refCallbacks.current.get(id);
    if (cb) return cb;
    cb = (el: HTMLDivElement | null) => {
      const map = cardEls.current;
      const prev = map.get(id);
      if (prev && prev !== el) observerRef.current?.unobserve(prev);
      if (el) {
        el.dataset.cardId = id;
        map.set(id, el);
        observerRef.current?.observe(el);
      } else {
        map.delete(id);
        cardHeights.current.delete(id);
      }
    };
    refCallbacks.current.set(id, cb);
    return cb;
  }, []);

  useEffect(() => {
    if (!open) return;
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.cardId;
        if (!id) continue;
        const h = el.offsetHeight;
        const prev = cardHeights.current.get(id);
        if (prev === undefined || Math.abs(prev - h) > 0.5) {
          cardHeights.current.set(id, h);
          changed = true;
        }
      }
      if (changed) requestRemeasure();
    });
    observerRef.current = obs;
    for (const el of cardEls.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [open, requestRemeasure]);

  useEffect(() => {
    if (!open) return;
    const handler = () => requestRemeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [open, requestRemeasure]);

  const measureOpenColumnWidth = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const next = el.getBoundingClientRect().width;
    if (next < MIN_OPEN_COLUMN_WIDTH_PX) return;
    setOpenColumnWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
  }, []);

  useLayoutEffect(() => {
    if (!hasTrackedColumnOpen.current) {
      hasTrackedColumnOpen.current = true;
      return;
    }

    columnWidthTransitioning.current = true;
    const timeout = window.setTimeout(() => {
      columnWidthTransitioning.current = false;
      if (open) measureOpenColumnWidth();
      // The open/close transition changes the document column's width →
      // the text reflows and every anchor below the fold moves. Remeasure
      // here as well as in the ResizeObserver so the anchors are right
      // even where the observer is throttled.
      requestRemeasure();
    }, COLUMN_WIDTH_TRANSITION_FALLBACK_MS);

    return () => window.clearTimeout(timeout);
  }, [open, measureOpenColumnWidth, requestRemeasure]);

  useLayoutEffect(() => {
    if (!open) return;
    if (columnWidthTransitioning.current) return;
    measureOpenColumnWidth();
  }, [open, measureOpenColumnWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const measureIfStable = () => {
      if (columnWidthTransitioning.current) return;
      measureOpenColumnWidth();
    };

    measureIfStable();
    const obs = new ResizeObserver(measureIfStable);
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, measureOpenColumnWidth]);

  // Measure the toolbar height so cards can stack below it. Re-runs on
  // any toolbar resize (e.g. theme/font changes that nudge the icon row).
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) {
      setToolbarHeight(0);
      return;
    }
    const measure = () => {
      const next = el.offsetHeight;
      setToolbarHeight((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // The document can reflow without a single DOM mutation — webfont and
  // image loads, the column itself opening (which narrows the text), a
  // reading-width change — silently shifting every anchor below the
  // reflow point. Watching the article's box size catches all of them;
  // without this the measured tops drift by thousands of pixels on long
  // documents and cards render next to the wrong text.
  useEffect(() => {
    if (!open) return;
    const doc = docElementRef.current;
    if (!doc || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(() => requestRemeasure());
    obs.observe(doc);
    return () => obs.disconnect();
  }, [open, docElementRef, requestRemeasure]);

  // Webfont swaps reflow the text without resizing anything the other
  // observers watch reliably — one explicit remeasure once all fonts land.
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined' || !document.fonts?.ready) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) requestRemeasure();
    });
    return () => {
      cancelled = true;
    };
  }, [open, requestRemeasure]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: docHtml is the explicit re-attach trigger so the observer points at the freshly rendered DOM after a content swap.
  useEffect(() => {
    if (!open) return;
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    // Coalesce bursts of mutations (e.g. when the highlight sync wraps
    // many text nodes in a single pass) into one remeasure per
    // animation frame so we don't trigger a render + layout pass per
    // mutation record.
    let raf = 0;
    const obs = new MutationObserver(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        requestRemeasure();
      });
    });
    obs.observe(doc, { childList: true, subtree: true, characterData: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [docElementRef, open, requestRemeasure, docHtml]);

  // Scroll listener — only setStates when the (epoch, isSticky) tuple
  // actually flips, which is at most 2N events for the whole document.
  // Pure scrolling between transitions is browser-native CSS sticky.
  // Only attached when stacking is on; the non-stacking layout has no
  // scroll-driven state to update. Native scroll events fire faster
  // than the display refresh on macOS/iOS — coalesce bursts into one
  // recomputation per animation frame so the O(N) global-state scan
  // doesn't run multiple times per painted frame on long docs.
  useEffect(() => {
    if (!open || !stackingEnabled) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        recomputeGlobalState();
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [open, recomputeGlobalState, scrollContainerRef, stackingEnabled]);

  // Keep the visible band current for as long as a draft is open, so
  // the composer stays clamped into view while the reader scrolls
  // around the text they are quoting.
  useEffect(() => {
    if (!open || !pendingAnchor) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        syncViewport();
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [open, pendingAnchor, scrollContainerRef, syncViewport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion / docHtml are explicit re-measure triggers; requestRemeasure is the action invoked from the body.
  useLayoutEffect(() => {
    if (!open) return;
    let heightsChanged = false;
    for (const [id, el] of cardEls.current) {
      const h = el.offsetHeight;
      if (h <= 0) continue;
      const prev = cardHeights.current.get(id);
      if (prev === undefined || Math.abs(prev - h) > 0.5) {
        cardHeights.current.set(id, h);
        heightsChanged = true;
      }
    }
    const naturalsChanged = measureNaturalTops();
    recomputeGlobalState();
    // Before paint, so a composer that opens off-screen is clamped on
    // its first frame rather than jumping in after one.
    syncViewport();
    // If refs changed but layoutVersion is the value that triggered
    // THIS effect, the orderedMetrics memo is still keyed on the
    // pre-update layoutVersion and would skip re-derivation. Bump
    // it so the next render reads fresh metrics. The bump is a
    // no-op on the next pass because measurements are stable, so no
    // infinite loop.
    if (heightsChanged || naturalsChanged) requestRemeasure();
  }, [
    measureNaturalTops,
    recomputeGlobalState,
    syncViewport,
    layoutVersion,
    docHtml,
    open,
    requestRemeasure,
  ]);

  // ----- focus animation -----

  useEffect(() => {
    if (!focusedThread) return;
    if (lastNonce.current === focusedThread.nonce) return;

    const exists = threads.some((t) => t.id === focusedThread.threadId);
    if (!exists) return;

    // A nested proposal renders inside its answered thread's card, so
    // that card must be expanded too for the target to be visible.
    // Expand first and leave the nonce unhandled: the collapse-state
    // change re-runs this effect, and only that second pass — with the
    // target actually in the DOM — scrolls and flashes.
    const parentId = nesting.parentOf.get(focusedThread.threadId);
    const toExpand = [focusedThread.threadId, ...(parentId ? [parentId] : [])].filter((id) =>
      collapsed.has(id),
    );
    if (toExpand.length > 0) {
      setCollapseState((prev) => {
        const expand = toExpand.filter((id) => prev.collapsed.has(id));
        if (expand.length === 0) return prev;
        const next = new Set(prev.collapsed);
        for (const id of expand) next.delete(id);
        return { ...prev, collapsed: next };
      });
      return;
    }
    lastNonce.current = focusedThread.nonce;

    const phase: 'a' | 'b' = focusedThread.nonce % 2 === 0 ? 'b' : 'a';
    setFocusedId(focusedThread.threadId);
    setFlash({ id: focusedThread.threadId, phase });

    const raf = focusedThread.scroll
      ? window.requestAnimationFrame(() => {
          const el = rootRef.current?.querySelector<HTMLElement>(
            `[data-comment-thread-id="${CSS.escape(focusedThread.threadId)}"]`,
          );
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })
      : -1;
    const flashT = window.setTimeout(() => {
      setFlash((cur) => (cur?.id === focusedThread.threadId && cur.phase === phase ? null : cur));
    }, COMMENT_FLASH_MS);
    const focusT = window.setTimeout(() => {
      setFocusedId((cur) => (cur === focusedThread.threadId ? null : cur));
    }, FOCUS_MS);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(flashT);
      window.clearTimeout(focusT);
    };
  }, [focusedThread, threads, collapsed, nesting]);

  function toggle(id: string) {
    setCollapseState((prev) => {
      const next = new Set(prev.collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, collapsed: next };
    });
  }

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  // Plain function (not useCallback). The result is used inline in
  // the JSX render loop, never passed as a prop, so memoization
  // would buy nothing — and the previous useCallback omitted several
  // changing handler props (onReply / onEdit / on… / onScrollToAnchor),
  // which risked stale closures after identity / displayName updates
  // re-bind the parent's callbacks.
  function renderCardById(id: string): ReactNode {
    if (id === PENDING_ID) {
      if (!pendingAnchor || !canComment) return null;
      return (
        <div className="ic-card ic-card-pending">
          <div className="ic-pending-quote">"{formatAnchorQuote(pendingAnchor.quote, 160)}"</div>
          <InlineComposer
            placeholder="Your comment…"
            needsName={!displayName}
            mentionCandidates={mentionCandidates}
            rows={3}
            submitLabel="Post"
            showCancel
            autoFocus
            onCancel={onCancelPending}
            onSubmit={submitNew}
          />
        </div>
      );
    }
    const item = sortedById.get(id);
    if (!item) return null;
    return renderCard(item.thread, nestedThreadsOf(nesting, id), null);
  }

  function renderCard(
    thread: Thread,
    nested: readonly Thread[],
    parentId: string | null,
  ): ReactNode {
    const blockId = thread.anchor.block_id;
    const onJump = blockId
      ? () => scrollToAnchorWithOffset(blockId, thread.anchor.quote, thread.id)
      : undefined;
    const rawLinks = threadLinks(thread, byId);
    // Proposals rendered inside this card need no "See proposed change"
    // link on top — the card itself is right below. A nested proposal
    // likewise drops the "Answers:" link to the card it sits in, but
    // keeps the ones to the other comments it answers.
    const nestedIds = new Set(nested.map((n) => n.id));
    const links = {
      answers: parentId ? rawLinks.answers.filter((t) => t.id !== parentId) : rawLinks.answers,
      answeredBy: rawLinks.answeredBy.filter((t) => !nestedIds.has(t.id)),
    };
    return (
      <InlineThreadCard
        key={thread.id}
        uid={uid}
        thread={thread}
        links={links}
        nested={parentId !== null}
        nestedCards={
          nested.length > 0 ? nested.map((n) => renderCard(n, [], thread.id)) : undefined
        }
        onFocusLinked={focusLinked}
        threadRefs={threadRefs}
        canComment={canComment}
        needsName={!displayName}
        focused={focusedId === thread.id}
        flashPhase={flash?.id === thread.id ? flash.phase : null}
        collapsed={collapsed.has(thread.id)}
        mentionCandidates={mentionCandidates}
        onToggleCollapsed={() => toggle(thread.id)}
        onJump={onJump}
        onReply={onReply}
        onEdit={onEdit}
        onSetHidden={onSetHidden}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
        onRepairThread={onRepairThread}
        onResolveConflict={onResolveConflict}
        onReact={onReact}
        onCreateProposal={onCreateProposal}
        onEditProposal={onEditProposal}
      />
    );
  }

  const showEmpty = sorted.length === 0 && !pendingAnchor;
  const minHeight = Math.max(columnHeight, stackingEnabled ? 0 : noStackLayout.totalHeight);

  return (
    <aside
      ref={rootRef}
      className={`ic-column${stackingEnabled ? '' : ' ic-column-no-stacking'}${open ? '' : ' ic-column-collapsed'}`}
      aria-label="Inline comments"
      style={open ? { minHeight: `${minHeight}px` } : undefined}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'flex-basis') return;
        columnWidthTransitioning.current = false;
        if (open) measureOpenColumnWidth();
      }}
    >
      <InlineCommentsToolbar
        rootRef={toolbarRef}
        sortedThreads={sortedThreads}
        scrollContainerRef={scrollContainerRef}
        docElementRef={docElementRef}
        lastNavThreadRef={lastNavThreadRef}
        stickyTopPad={stickyTopPad}
        layoutVersion={layoutVersion}
        open={open}
        onToggleOpen={onToggleOpen}
        stackingEnabled={stackingEnabled}
        onToggleStacking={onToggleStacking}
        hideResolved={hideResolved}
        onToggleHideResolved={onToggleHideResolved}
        onSwitchToFloating={onSwitchToFloating}
        onScrollToAnchor={scrollToAnchorWithOffset}
      />
      <div className="ic-column-clip" aria-hidden={!open}>
        <div className="ic-column-content" style={{ inlineSize: `${openColumnWidth}px` }}>
          {renderItems.map((item, k) => {
            const naturalTop = orderedMetrics.anchors[k] ?? 0;
            const cardHeight = orderedMetrics.heights[k] ?? 96;
            const { epoch, isSticky } = globalState;

            let containerTop: number;
            let containerHeight: number;
            let useSticky: boolean;
            let stickyTop = 0;

            if (!stackingEnabled) {
              // No sticky behaviour: card sits at its anchor (or pushed
              // down by the previous card if they would overlap) and
              // scrolls with the document.
              containerTop = noStackLayout.tops[k] ?? naturalTop;
              containerHeight = cardHeight;
              useSticky = false;
            } else if (k < epoch) {
              // Card has already passed its anchor and landed. We add the
              // sticky top-pad to the landed scroll-y so the transition
              // out of the SCROLLING phase is continuous (the card sat at
              // viewport-y=stickyTopPad while sticky and stays at the
              // same screen position when it lands).
              containerTop = naturalTop + stickyTopPad;
              containerHeight = cardHeight;
              useSticky = false;
            } else if (isSticky) {
              // Stacked phase for the current stack [epoch..N-1].
              //   container.top    = phaseStart + T
              //   container.height = phaseEnd  - phaseStart + cardHeight
              // chosen so the inner sticks at viewport-y = T from
              // scrollTop=phaseStart and disengages at scrollTop=phaseEnd.
              const T = stackOffset(k, epoch);
              const phaseStart =
                epoch === 0
                  ? 0
                  : (orderedMetrics.anchors[epoch - 1] ?? 0) +
                    (orderedMetrics.heights[epoch - 1] ?? 96) +
                    STACK_GAP_PX;
              const phaseEnd = orderedMetrics.anchors[epoch] ?? naturalTop;
              containerTop = phaseStart + T;
              containerHeight = Math.max(phaseEnd - phaseStart + cardHeight, cardHeight);
              stickyTop = T;
              useSticky = true;
            } else {
              // Scrolling phase: cards in [epoch..N-1] ride the document
              // with their stacked offsets between anchor[epoch] and the
              // moment card_epoch leaves the viewport.
              const T = stackOffset(k, epoch);
              containerTop = (orderedMetrics.anchors[epoch] ?? 0) + T;
              containerHeight = cardHeight;
              useSticky = false;
            }

            // The composer is the one card that has to be on screen — it
            // is autofocused and about to be typed into. Its turn in the
            // stack comes after every card anchored above it, so a block
            // a few paragraphs into a commented run puts it below the
            // fold while the text it quotes is in plain view, leaving the
            // right pane's copy as the only visible one. Lift it out of
            // the pile in that case; the other cards can afford to be
            // scrolled away from, and the draft is gone again on post or
            // cancel.
            let lifted = false;
            if (item.id === PENDING_ID && viewport.height > 0) {
              const cardTop = useSticky
                ? Math.min(
                    Math.max(containerTop, viewport.top + stickyTop),
                    containerTop + containerHeight - cardHeight,
                  )
                : containerTop;
              const highest = viewport.top + stickyTopPad;
              const lowest = Math.max(
                highest,
                viewport.top + viewport.height - cardHeight - STACK_GAP_PX,
              );
              const clamped = Math.min(Math.max(cardTop, highest), lowest);
              if (Math.abs(clamped - cardTop) > 0.5) {
                containerTop = clamped;
                containerHeight = cardHeight;
                useSticky = false;
                lifted = true;
              }
            }

            return (
              <div
                key={item.id}
                className={`ic-anchor-slot${lifted ? ' ic-anchor-slot-lifted' : ''}`}
                style={{ top: `${containerTop}px`, height: `${containerHeight}px` }}
              >
                <div
                  ref={getRefCallback(item.id)}
                  className="ic-sticky-card"
                  style={
                    useSticky
                      ? { position: 'sticky', top: `${stickyTop}px` }
                      : { position: 'static' }
                  }
                >
                  {renderCardById(item.id)}
                </div>
              </div>
            );
          })}

          {showEmpty && (
            <div className="ic-empty-state">
              {canComment ? 'Select text in the document to comment.' : 'No comments yet.'}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function shouldAutoCollapse(t: Thread): boolean {
  if (t.state === 'resolved') return true;
  if (isProposal(t)) {
    const s = proposalStatus(t);
    if (s === 'accepted' || s === 'rejected') return true;
  }
  return false;
}
