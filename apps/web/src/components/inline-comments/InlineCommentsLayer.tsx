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
   * When true: at scroll=0 every card is sticky-stacked at the top in
   * doc order. Once scroll reaches the first card's anchor, all cards
   * unstick and scroll with the document together. As each card scrolls
   * out of view, the next card re-engages sticky alone at the top.
   *
   * When false: cards sit at their anchor and scroll with the document
   * with no sticky behavior.
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
const STICKY_TOP_PAD_PX = 4;
const FLASH_MS = 760;
const FOCUS_MS = 1800;

/**
 * Each card has two CSS sticky configurations and JS flips between them
 * exactly once per card.
 *
 *   Config 'A' covers Phase 1 (initial stack) and Phase 2 (post-unstick
 *   landed at stack offset). Container spans [0, anchor1 + T_n + h_n];
 *   inner is sticky;top:T_n. While scroll is in [0, anchor1] the card
 *   sticks at viewport-y=T_n; while scroll is in [anchor1, anchor1+T_n]
 *   it sits at scroll-y=anchor1+T_n and rides up with the document.
 *
 *   Config 'B' covers Phase 3 (solo sticky) and Phase 4 (landed at own
 *   anchor). Container spans [anchor1 + T_n, anchor_n + h_n]; inner is
 *   sticky;top:0. While scroll is in [anchor1+T_n, anchor_n] the card
 *   sticks at viewport-y=0; once scroll passes anchor_n it lands at
 *   scroll-y=anchor_n.
 *
 * The flip happens at scrollTop = anchor1 + T_n. Visual continuity is
 * preserved at the flip because both configs put the card at viewport
 * y=0 at that exact scroll position.
 */
type StickyConfig = 'A' | 'B';

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

  // Reconcile auto-collapse defaults when threads are added or change state.
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

  // ----- measurement state -----

  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const naturalTops = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);

  const [layoutVersion, setLayoutVersion] = useState(0);
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [configs, setConfigs] = useState<Map<string, StickyConfig>>(new Map());

  const requestRemeasure = useCallback(() => {
    setLayoutVersion((n) => n + 1);
  }, []);

  /**
   * Stack offset T_n for each card: cumulative height (incl. gap) of the
   * cards above it in document order. Used as the sticky `top:` value
   * during Config A so cards stack vertically from the viewport top.
   */
  const stackOffsets = useMemo(() => {
    const map = new Map<string, number>();
    let cumulative = STICKY_TOP_PAD_PX;
    for (const item of renderItems) {
      map.set(item.id, cumulative);
      const h = cardHeights.current.get(item.id) ?? 96;
      cumulative += h + STACK_GAP_PX;
    }
    return map;
    // layoutVersion in deps so the recompute fires when heights update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, layoutVersion]);

  /** First card's anchor position — the global "all unstick" trigger. */
  const firstAnchor = useMemo(() => {
    if (renderItems.length === 0) return 0;
    const first = renderItems[0];
    if (!first) return 0;
    return naturalTops.current.get(first.id) ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, layoutVersion]);

  /**
   * scrollTop at which card_n flips from Config A to Config B.
   * = first_anchor + T_n. Chosen so the card's viewport-y is exactly 0
   * at the flip in both configs (no visual jump).
   */
  const flipPoints = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of renderItems) {
      map.set(item.id, firstAnchor + (stackOffsets.get(item.id) ?? 0));
    }
    return map;
  }, [renderItems, firstAnchor, stackOffsets]);

  /** Recompute each card's anchor position from the rendered doc. */
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

  /** Compute each card's current Config from scrollTop; only setState if any flipped. */
  const recomputeConfigs = useCallback(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const scrollTop = scroll.scrollTop;
    setConfigs((prev) => {
      let changed = false;
      const next = new Map<string, StickyConfig>();
      for (const item of renderItems) {
        const flip = flipPoints.get(item.id) ?? 0;
        const cfg: StickyConfig = scrollTop >= flip ? 'B' : 'A';
        next.set(item.id, cfg);
        if (prev.get(item.id) !== cfg) changed = true;
      }
      if (!changed && next.size === prev.size) return prev;
      return next;
    });
  }, [renderItems, flipPoints, scrollContainerRef]);

  // Stable per-id ref callbacks. Inline arrow refs would re-attach every
  // render; this preserves identity so the ResizeObserver and stable DOM
  // remain in sync.
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

  // ResizeObserver — track each card's actual rendered height so the
  // stack offsets and slot heights stay accurate when a card expands.
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

  // Window resize → re-measure (gutter width depends on viewport).
  useEffect(() => {
    const handler = () => requestRemeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [requestRemeasure]);

  // Article DOM mutations → re-measure.
  useEffect(() => {
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => requestRemeasure());
    obs.observe(doc, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [docElementRef, requestRemeasure, docHtml]);

  // Scroll listener — pure config-flip detection, no per-frame DOM
  // writes. setState short-circuits when nothing flipped, so common-case
  // scrolling triggers zero React work and zero JS DOM writes.
  useEffect(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const onScroll = () => recomputeConfigs();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [recomputeConfigs, scrollContainerRef]);

  // Layout effect: refresh heights from offsetHeight before measuring
  // naturals so the very first paint uses real values.
  useLayoutEffect(() => {
    for (const [id, el] of cardEls.current) {
      const h = el.offsetHeight;
      if (h > 0) cardHeights.current.set(id, h);
    }
    measureNaturalTops();
    recomputeConfigs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureNaturalTops, recomputeConfigs, layoutVersion, docHtml]);

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
      {renderItems.map((item) => {
        const naturalTop = naturalTops.current.get(item.id) ?? 0;
        const cardHeight = cardHeights.current.get(item.id) ?? 96;
        const T = stackOffsets.get(item.id) ?? 0;
        const cfg = configs.get(item.id) ?? 'A';

        let containerTop: number;
        let containerHeight: number;
        let stickyTop: number;
        let useSticky: boolean;

        if (!stackingEnabled) {
          containerTop = naturalTop;
          containerHeight = cardHeight;
          stickyTop = 0;
          useSticky = false;
        } else if (cfg === 'A') {
          // Phase 1 + 2: sticky-stacked at top, then lands at stack offset.
          containerTop = 0;
          containerHeight = Math.max(firstAnchor + T + cardHeight, cardHeight);
          stickyTop = T;
          useSticky = true;
        } else {
          // Phase 3 + 4: solo sticky at viewport top, then lands at own anchor.
          containerTop = firstAnchor + T;
          const target = naturalTop + cardHeight - containerTop;
          containerHeight = Math.max(target, cardHeight);
          stickyTop = STICKY_TOP_PAD_PX;
          useSticky = true;
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
