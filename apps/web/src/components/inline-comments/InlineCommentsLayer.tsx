import type { BlockSourceRange } from '@marginalia/renderer';
import {
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
  /** Used as a re-measure trigger: bumps when the rendered HTML swaps. */
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  blockRanges: Map<string, BlockSourceRange>;
  canComment: boolean;
  /**
   * When true, cards whose anchor is below the viewport pin to the top of
   * the column in document order and travel with the scroll until their
   * anchor catches up. When false, cards sit at their anchor and scroll
   * with it; if two cards collide they stack downward from the upper one.
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
  /** Stable key — thread id, or PENDING_ID for the new-comment composer. */
  id: string;
  /** Block to anchor against. */
  blockId: string | null;
}

const PENDING_ID = '__pending__';
const CARD_GAP_PX = 8;
const TOP_PAD_PX = 4;
const FLASH_MS = 760;
const FOCUS_MS = 1800;

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

  /**
   * Render order — used by the layout pass. The pending composer sits at
   * the head if present so its block-anchor is processed before the
   * thread anchors that follow it (cards process in document order, then
   * pin-stack any that haven't reached their anchor yet).
   */
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = sorted.map((s) => ({ id: s.thread.id, blockId: s.thread.anchor.block_id }));
    if (canComment && pendingAnchor) {
      items.push({ id: PENDING_ID, blockId: pendingAnchor.block_id });
    }
    return items;
  }, [sorted, canComment, pendingAnchor]);

  // ----- positioning state -----
  // Cards' visual `top` is managed via direct DOM writes (not React style)
  // so scroll-driven updates can run at 60fps without rerendering, and so
  // that we can selectively disable the CSS transition during scroll.

  const wrapperEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const naturalTops = useRef<Map<string, number>>(new Map());
  const lastAppliedTops = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [measureNonce, setMeasureNonce] = useState(0);

  const requestRemeasure = useCallback(() => {
    setMeasureNonce((n) => n + 1);
  }, []);

  /**
   * Walk render items in document order and write each card's `top`.
   * Each card has a "natural rest" position (its anchor in the doc) and
   * a "pinned" position (stacked from the viewport top alongside any
   * earlier cards whose anchors haven't scrolled into view yet). A card
   * lands at its natural rest the moment scroll catches up to it.
   *
   * `animated` controls whether the change interpolates via the CSS
   * transition. False for scroll-driven frames (cards must track the
   * viewport without lag), true for height/insert reflows.
   */
  const applyPositions = useCallback(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const scrollTop = scroll.scrollTop;
    // When stacking is on, cursor starts at the viewport top so cards
    // whose anchor is below the viewport pin in a stack from there.
    // When stacking is off, cursor starts at -∞ so cards never pin —
    // they only collide downward against the previous card.
    let cursor = stackingEnabled ? scrollTop + TOP_PAD_PX : Number.NEGATIVE_INFINITY;

    for (const item of renderItems) {
      const id = item.id;
      const naturalTop = naturalTops.current.get(id) ?? 0;
      const height = cardHeights.current.get(id) ?? 96;

      let finalTop: number;
      if (stackingEnabled && naturalTop > cursor) {
        // Anchor is still below the pinned cursor — card stays pinned
        // at the cursor and travels with the viewport.
        finalTop = cursor;
        cursor = cursor + height + CARD_GAP_PX;
      } else {
        // Anchor has scrolled into (or above) the pinned cursor — card
        // lands at its natural rest and stays bound to the document.
        // (When stacking is off this branch always runs.)
        finalTop = Math.max(naturalTop, cursor);
        cursor = finalTop + height + CARD_GAP_PX;
      }

      const wrapper = wrapperEls.current.get(id);
      if (!wrapper) continue;
      const last = lastAppliedTops.current.get(id);
      if (last === undefined || Math.abs(last - finalTop) > 0.5) {
        wrapper.style.top = `${finalTop}px`;
        lastAppliedTops.current.set(id, finalTop);
      }
    }
  }, [renderItems, scrollContainerRef, stackingEnabled]);

  /**
   * Briefly enable the CSS `top` transition for one reflow cycle.
   * Used by the layout effect when a height change or insert moves
   * cards relative to each other; not used by the scroll handler so
   * scroll-driven moves stay 1:1 with the viewport.
   */
  const animateNextLayout = useCallback(() => {
    for (const el of wrapperEls.current.values()) el.classList.add('animating');
    return window.setTimeout(() => {
      for (const el of wrapperEls.current.values()) el.classList.remove('animating');
    }, 260);
  }, []);

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
    // Drop entries for items that no longer exist.
    const live = new Set(renderItems.map((i) => i.id));
    for (const id of Array.from(naturalTops.current.keys())) {
      if (!live.has(id)) {
        naturalTops.current.delete(id);
        cardHeights.current.delete(id);
        lastAppliedTops.current.delete(id);
      }
    }
    setColumnHeight((prev) => (Math.abs(prev - maxBottom) > 0.5 ? maxBottom : prev));
  }, [renderItems, docElementRef, scrollContainerRef]);

  // ResizeObserver — detect card-height changes (composer expands, replies
  // added, etc.) and re-flow other cards to match, with the animated
  // transition.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.cardId;
        if (!id) continue;
        // Use offsetHeight rather than contentRect: contentRect omits
        // border (and would also omit padding for box-sizing:content-box
        // children) which can leave the layout pass thinking the card is
        // smaller than it really is and overlapping it with the next.
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
    for (const el of wrapperEls.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [requestRemeasure]);

  // Stable ref callback per id. Without memoization, an inline arrow in
  // JSX is a fresh function each render, so React detaches+reattaches the
  // ref every render — which would then re-run the observer wiring and
  // any state updates inside it on every render.
  const refCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const getRefCallback = useCallback((id: string) => {
    let cb = refCallbacks.current.get(id);
    if (cb) return cb;
    cb = (el: HTMLDivElement | null) => {
      const map = wrapperEls.current;
      const prev = map.get(id);
      if (prev && prev !== el) observerRef.current?.unobserve(prev);
      if (el) {
        el.dataset.cardId = id;
        map.set(id, el);
        observerRef.current?.observe(el);
      } else {
        map.delete(id);
        cardHeights.current.delete(id);
        lastAppliedTops.current.delete(id);
      }
    };
    refCallbacks.current.set(id, cb);
    return cb;
  }, []);

  // Window resize → re-measure.
  useEffect(() => {
    const handler = () => requestRemeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [requestRemeasure]);

  // Article DOM mutations (mermaid SVG injection, image loads, doc
  // reflow on width slider) → re-measure.
  useEffect(() => {
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => requestRemeasure());
    obs.observe(doc, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [docElementRef, requestRemeasure, docHtml]);

  // Scroll listener — runs synchronously inside the scroll event so the
  // DOM write lands in the same paint as the scroll itself. Wrapping it
  // in requestAnimationFrame would defer the write to the *next* paint,
  // making cards visibly trail the scroll by one frame (the flicker we
  // saw before). The work per call is bounded — one loop over
  // renderItems with an early-exit when positions haven't changed —
  // and modern browsers throttle scroll events to roughly one per frame.
  useEffect(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const onScroll = () => applyPositions();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [applyPositions, scrollContainerRef]);

  // The layout pass: re-runs when natural positions or render items
  // change. Wraps the position update in a transient "animating" class
  // so cross-card reflows ease into place via the CSS transition,
  // while scroll-driven updates (which never set the class) remain
  // instant.
  useLayoutEffect(() => {
    // Refresh heights from offsetHeight before the layout pass so the
    // very first paint uses real values rather than a stub default.
    // (The ResizeObserver covers ongoing changes; this seeds the
    // initial frame and any new cards added between observer ticks.)
    for (const [id, el] of wrapperEls.current) {
      const h = el.offsetHeight;
      if (h > 0) cardHeights.current.set(id, h);
    }
    measureNaturalTops();
    const t = animateNextLayout();
    applyPositions();
    return () => window.clearTimeout(t);
  }, [measureNaturalTops, applyPositions, animateNextLayout, measureNonce, docHtml]);

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

  const showEmpty = sorted.length === 0 && !pendingAnchor;
  const minHeight = Math.max(columnHeight, 0);

  return (
    <aside
      ref={rootRef}
      className="ic-column"
      aria-label="Inline comments"
      style={{ minHeight: `${minHeight}px` }}
    >
      {showEmpty && (
        <div className="ic-empty-state">
          {canComment ? 'Select text in the document to comment.' : 'No comments yet.'}
        </div>
      )}

      {canComment && pendingAnchor && (
        <div ref={getRefCallback(PENDING_ID)} className="ic-anchor-wrapper">
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
        </div>
      )}

      {sorted.map((item) => {
        const blockId = item.thread.anchor.block_id;
        const onJump = blockId ? () => onScrollToAnchor(blockId) : undefined;
        const id = item.thread.id;
        return (
          <div key={id} ref={getRefCallback(id)} className="ic-anchor-wrapper">
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
          </div>
        );
      })}
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
