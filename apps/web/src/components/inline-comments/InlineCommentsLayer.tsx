import type { BlockSourceRange } from '@marginalia/renderer';
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
import type { CommentAnchor, Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';
import {
  buildThreadCollapseState,
  reconcileThreadCollapseState,
  type ThreadCollapseState,
} from '../threadCollapseState.js';
import type { DocumentFormat } from '../../lib/api.js';
import { InlineCommentsToolbar } from './InlineCommentsToolbar.js';
import { InlineComposer } from './InlineComposer.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import { COMMENT_FLASH_MS } from './inlineUtils.js';

interface Props {
  uid: string;
  threads: Thread[];
  docSource: string;
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  blockRanges: Map<string, BlockSourceRange>;
  docFormat: DocumentFormat;
  canComment: boolean;
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
  /** When true, threads with `state === 'resolved'` (resolved comments,
   *  accepted proposals, rejected proposals) are filtered out of the
   *  column entirely — they don't appear, don't take space, and don't
   *  participate in the sticky-stacking calculations. */
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number; scroll: boolean } | null;
  displayName: string | null;
  onCancelPending: () => void;
  onCreate: (payload: {
    anchor: CommentAnchor;
    body: string;
    display_name?: string;
  }) => Promise<void>;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<void>;
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string, scrollOffset?: number) => void;
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
  docSource,
  docHtml,
  docElementRef,
  scrollContainerRef,
  blockRanges,
  docFormat,
  canComment,
  stackingEnabled,
  onToggleStacking,
  hideResolved,
  onToggleHideResolved,
  pendingAnchor,
  focusedThread,
  displayName,
  onCancelPending,
  onCreate,
  onReply,
  onEdit,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onScrollToAnchor,
}: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const stickyTopPad = TOOLBAR_BASE_TOP_PAD_PX + toolbarHeight;

  /**
   * Apply the show/hide-resolved filter once, upstream of every
   * derivation that follows. `state === 'resolved'` covers resolved
   * comments, accepted proposals, and rejected proposals — they all
   * share that state, only `resolution.kind` differs.
   */
  const visibleThreads = useMemo(
    () => (hideResolved ? threads.filter((t) => t.state !== 'resolved') : threads),
    [threads, hideResolved],
  );

  /**
   * Auto-collapse defaults derived from the current thread list.
   * Threads start collapsed when they're already resolved or accepted/
   * rejected proposals. The shared reconciler tracks "auto-collapse
   * just activated" so a thread the user manually expanded doesn't
   * snap back to collapsed when something else triggers a re-render.
   */
  const collapseDefaults = useMemo(
    () =>
      visibleThreads.map((t) => ({
        id: t.id,
        autoCollapse: shouldAutoCollapse(t),
      })),
    [visibleThreads],
  );
  const [collapseState, setCollapseState] = useState<ThreadCollapseState>(() =>
    buildThreadCollapseState(collapseDefaults),
  );
  const collapsed = collapseState.collapsed;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);
  const lastNonce = useRef<number | null>(null);

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
    const items: OrderItem[] = visibleThreads.map((t) => ({
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
  }, [visibleThreads, blockOrder]);

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

  function resolveAnchorElement(
    doc: HTMLElement,
    blockId: string,
    quote?: string | null,
  ): HTMLElement | null {
    const escaped = CSS.escape(blockId);
    let target = doc.querySelector<HTMLElement>(
      `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
    );
    if (!target) return null;
    if (!target.dataset.block || !quote) return target;

    const subEls = target.querySelectorAll<HTMLElement>('[data-subblock]');
    let narrowed: HTMLElement | null = null;
    let unique = true;
    for (const sub of subEls) {
      const text = (sub.textContent ?? '').replace(/\s+/gu, ' ').trim();
      if (!text.includes(quote)) continue;
      if (narrowed) {
        unique = false;
        break;
      }
      narrowed = sub;
    }
    return unique && narrowed ? narrowed : target;
  }

  /**
   * When stacking is disabled, cards sit at their natural anchor
   * positions (no stickyTopPad offset). Wrap onScrollToAnchor to
   * inject the stickyTopPad so the scrolled-to text appears with
   * the same clearance below the toolbar as in stacking mode.
   */
  const scrollToAnchorWithOffset = useCallback(
    (blockId: string, quote?: string | null, threadId?: string) => {
      onScrollToAnchor(blockId, quote, threadId, stackingEnabled ? 0 : stickyTopPad);
    },
    [onScrollToAnchor, stackingEnabled, stickyTopPad],
  );

  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const naturalTops = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);

  const [layoutVersion, setLayoutVersion] = useState(0);
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [globalState, setGlobalState] = useState<GlobalState>({ epoch: 0, isSticky: true });

  const requestRemeasure = useCallback(() => {
    setLayoutVersion((n) => n + 1);
  }, []);

  /** Anchors and heights as flat arrays in render order (for the state machine). */
  const orderedMetrics = useMemo(() => {
    const anchors: number[] = [];
    const heights: number[] = [];
    for (const item of renderItems) {
      anchors.push(naturalTops.current.get(item.id) ?? 0);
      heights.push(cardHeights.current.get(item.id) ?? 96);
    }
    return { anchors, heights };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const el = resolveAnchorElement(doc, item.blockId, item.quote);
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
  }, [requestRemeasure]);

  useEffect(() => {
    const handler = () => requestRemeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [requestRemeasure]);

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

  useEffect(() => {
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    // Coalesce bursts of mutations (e.g. when applyCommentHighlights
    // wraps many text nodes in a single pass) into one remeasure per
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
  }, [docElementRef, requestRemeasure, docHtml]);

  // Scroll listener — only setStates when the (epoch, isSticky) tuple
  // actually flips, which is at most 2N events for the whole document.
  // Pure scrolling between transitions is browser-native CSS sticky.
  // Only attached when stacking is on; the non-stacking layout has no
  // scroll-driven state to update. Native scroll events fire faster
  // than the display refresh on macOS/iOS — coalesce bursts into one
  // recomputation per animation frame so the O(N) global-state scan
  // doesn't run multiple times per painted frame on long docs.
  useEffect(() => {
    if (!stackingEnabled) return;
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
  }, [recomputeGlobalState, scrollContainerRef, stackingEnabled]);

  useLayoutEffect(() => {
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
    // If refs changed but layoutVersion is the value that triggered
    // THIS effect, the orderedMetrics memo is still keyed on the
    // pre-update layoutVersion and would skip re-derivation. Bump
    // it so the next render reads fresh metrics. The bump is a
    // no-op on the next pass because measurements are stable, so no
    // infinite loop.
    if (heightsChanged || naturalsChanged) requestRemeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureNaturalTops, recomputeGlobalState, layoutVersion, docHtml]);

  // ----- focus animation -----

  useEffect(() => {
    if (!focusedThread) return;
    if (lastNonce.current === focusedThread.nonce) return;
    lastNonce.current = focusedThread.nonce;

    const exists = threads.some((t) => t.id === focusedThread.threadId);
    if (!exists) return;

    if (collapsed.has(focusedThread.threadId)) {
      setCollapseState((prev) => {
        if (!prev.collapsed.has(focusedThread.threadId)) return prev;
        const next = new Set(prev.collapsed);
        next.delete(focusedThread.threadId);
        return { ...prev, collapsed: next };
      });
    }

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
  }, [focusedThread, threads, collapsed]);

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
          <div className="ic-pending-quote">"{truncate(pendingAnchor.quote, 160)}"</div>
          <InlineComposer
            placeholder="Your comment…"
            needsName={!displayName}
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
    const blockId = item.thread.anchor.block_id;
    const onJump = blockId
      ? () => scrollToAnchorWithOffset(blockId, item.thread.anchor.quote, item.thread.id)
      : undefined;
    return (
      <InlineThreadCard
        uid={uid}
        thread={item.thread}
        canComment={canComment}
        needsName={!displayName}
        focused={focusedId === id}
        flashPhase={flash?.id === id ? flash.phase : null}
        collapsed={collapsed.has(id)}
        onToggleCollapsed={() => toggle(id)}
        onJump={onJump}
        onReply={onReply}
        onEdit={onEdit}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
      />
    );
  }

  const showEmpty = sorted.length === 0 && !pendingAnchor;
  const minHeight = Math.max(
    columnHeight,
    stackingEnabled ? 0 : noStackLayout.totalHeight,
  );

  return (
    <aside
      ref={rootRef}
      className={`ic-column${stackingEnabled ? '' : ' ic-column-no-stacking'}`}
      aria-label="Inline comments"
      style={{ minHeight: `${minHeight}px` }}
    >
      <InlineCommentsToolbar
        rootRef={toolbarRef}
        sortedThreads={sorted.map((s) => s.thread)}
        scrollContainerRef={scrollContainerRef}
        cardNaturalTops={naturalTops.current}
        stickyTopPad={stickyTopPad}
        stackingEnabled={stackingEnabled}
        onToggleStacking={onToggleStacking}
        hideResolved={hideResolved}
        onToggleHideResolved={onToggleHideResolved}
        onScrollToAnchor={scrollToAnchorWithOffset}
      />
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

        return (
          <div
            key={item.id}
            className="ic-anchor-slot"
            style={{ top: `${containerTop}px`, height: `${containerHeight}px` }}
          >
            <div
              ref={getRefCallback(item.id)}
              className="ic-sticky-card"
              style={
                useSticky ? { position: 'sticky', top: `${stickyTop}px` } : { position: 'static' }
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

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
