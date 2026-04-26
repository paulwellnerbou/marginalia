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
import { InlineComposer } from './InlineComposer.js';
import { InlineThreadCard } from './InlineThreadCard.js';

interface Props {
  uid: string;
  threads: Thread[];
  docSource: string;
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  blockRanges: Map<string, BlockSourceRange>;
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
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number } | null;
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
  onEditProposalRationale: (id: string, rationale: string | null) => Promise<void>;
  onScrollToAnchor: (blockId: string) => void;
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
}

const PENDING_ID = '__pending__';
const STACK_GAP_PX = 8;
/**
 * Pixels of breathing room between the document chrome's bottom border
 * and the topmost sticky comment card. Doubles as the sticky `top:`
 * value for the lead card and the offset everything else stacks below.
 */
const STICKY_TOP_PAD_PX = 12;
const FLASH_MS = 760;
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
  canComment,
  stackingEnabled,
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
  onEditProposalRationale,
  onScrollToAnchor,
}: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const t of threads) {
      if (shouldAutoCollapse(t)) initial.add(t.id);
    }
    return initial;
  });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);
  const lastNonce = useRef<number | null>(null);

  useEffect(() => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const known = new Set(prev);
      for (const t of threads) {
        if (!known.has(t.id) && shouldAutoCollapse(t)) {
          next.add(t.id);
        }
      }
      const ids = new Set(threads.map((t) => t.id));
      for (const id of next) {
        if (!ids.has(id)) next.delete(id);
      }
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, [threads]);

  const blockOrder = useMemo(() => {
    const order = new Map<string, number>();
    let i = 0;
    for (const id of blockRanges.keys()) order.set(id, i++);
    return order;
  }, [blockRanges]);

  const sorted = useMemo<OrderItem[]>(() => {
    const items: OrderItem[] = threads.map((t) => ({
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
  }, [threads, blockOrder]);

  /** Render order — pending composer trails the threads in doc order. */
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = sorted.map((s) => ({
      id: s.thread.id,
      blockId: s.thread.anchor.block_id,
    }));
    if (canComment && pendingAnchor) {
      items.push({ id: PENDING_ID, blockId: pendingAnchor.block_id });
    }
    return items;
  }, [sorted, canComment, pendingAnchor]);

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

  /** Stack offset for card_k inside the stack of cards [epoch..N-1]. */
  const stackOffset = useCallback(
    (k: number, epoch: number): number => {
      if (k <= epoch) return 0;
      let sum = STICKY_TOP_PAD_PX;
      for (let i = epoch; i < k; i++) {
        sum += (orderedMetrics.heights[i] ?? 96) + STACK_GAP_PX;
      }
      return sum;
    },
    [orderedMetrics],
  );

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
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const next = computeGlobalState(scroll.scrollTop);
    setGlobalState((prev) =>
      prev.epoch === next.epoch && prev.isSticky === next.isSticky ? prev : next,
    );
  }, [computeGlobalState, scrollContainerRef]);

  /** Re-measure each card's anchor position from the rendered doc. */
  const measureNaturalTops = useCallback(() => {
    const doc = docElementRef.current;
    const scroll = scrollContainerRef.current;
    if (!doc || !scroll) return;
    const scrollRect = scroll.getBoundingClientRect();
    const scrollTop = scroll.scrollTop;
    let maxBottom = 0;
    for (const item of renderItems) {
      let nat = 0;
      if (item.blockId) {
        const escaped = CSS.escape(item.blockId);
        const el = doc.querySelector<HTMLElement>(
          `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
        );
        if (el) {
          nat = el.getBoundingClientRect().top - scrollRect.top + scrollTop;
        }
      }
      naturalTops.current.set(item.id, nat);
      const height = cardHeights.current.get(item.id) ?? 96;
      if (nat + height > maxBottom) maxBottom = nat + height;
    }
    const live = new Set(renderItems.map((i) => i.id));
    for (const id of Array.from(naturalTops.current.keys())) {
      if (!live.has(id)) {
        naturalTops.current.delete(id);
        cardHeights.current.delete(id);
      }
    }
    setColumnHeight((prev) => (Math.abs(prev - maxBottom) > 0.5 ? maxBottom : prev));
  }, [renderItems, docElementRef, scrollContainerRef]);

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

  useEffect(() => {
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => requestRemeasure());
    obs.observe(doc, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [docElementRef, requestRemeasure, docHtml]);

  // Scroll listener — only setStates when the (epoch, isSticky) tuple
  // actually flips, which is at most 2N events for the whole document.
  // Pure scrolling between transitions is browser-native CSS sticky.
  useEffect(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const onScroll = () => recomputeGlobalState();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [recomputeGlobalState, scrollContainerRef]);

  useLayoutEffect(() => {
    for (const [id, el] of cardEls.current) {
      const h = el.offsetHeight;
      if (h > 0) cardHeights.current.set(id, h);
    }
    measureNaturalTops();
    recomputeGlobalState();
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
      setCollapsed((prev) => {
        if (!prev.has(focusedThread.threadId)) return prev;
        const next = new Set(prev);
        next.delete(focusedThread.threadId);
        return next;
      });
    }

    const phase: 'a' | 'b' = focusedThread.nonce % 2 === 0 ? 'b' : 'a';
    setFocusedId(focusedThread.threadId);
    setFlash({ id: focusedThread.threadId, phase });

    const raf = window.requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(
        `[data-comment-thread-id="${CSS.escape(focusedThread.threadId)}"]`,
      );
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const flashT = window.setTimeout(() => {
      setFlash((cur) => (cur?.id === focusedThread.threadId && cur.phase === phase ? null : cur));
    }, FLASH_MS);
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
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  const renderCardById = useCallback(
    (id: string): ReactNode => {
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
              onCancel={onCancelPending}
              onSubmit={submitNew}
            />
          </div>
        );
      }
      const item = sorted.find((s) => s.thread.id === id);
      if (!item) return null;
      const blockId = item.thread.anchor.block_id;
      const onJump = blockId ? () => onScrollToAnchor(blockId) : undefined;
      return (
        <InlineThreadCard
          uid={uid}
          thread={item.thread}
          canComment={canComment}
          needsName={!displayName}
          docSource={docSource}
          blockRanges={blockRanges}
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
          onEditProposalRationale={onEditProposalRationale}
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sorted,
      pendingAnchor,
      canComment,
      displayName,
      blockRanges,
      docSource,
      focusedId,
      flash,
      collapsed,
      uid,
    ],
  );

  const showEmpty = sorted.length === 0 && !pendingAnchor;
  const minHeight = Math.max(columnHeight, 0);

  return (
    <aside
      ref={rootRef}
      className={`ic-column${stackingEnabled ? '' : ' ic-column-no-stacking'}`}
      aria-label="Inline comments"
      style={{ minHeight: `${minHeight}px` }}
    >
      {renderItems.map((item, k) => {
        const naturalTop = orderedMetrics.anchors[k] ?? 0;
        const cardHeight = orderedMetrics.heights[k] ?? 96;
        const { epoch, isSticky } = globalState;

        let containerTop: number;
        let containerHeight: number;
        let useSticky: boolean;
        let stickyTop = 0;

        if (!stackingEnabled) {
          // No sticky behaviour: card sits at its anchor and scrolls
          // with the document.
          containerTop = naturalTop;
          containerHeight = cardHeight;
          useSticky = false;
        } else if (k < epoch) {
          // Card has already passed its anchor and landed.
          containerTop = naturalTop;
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
