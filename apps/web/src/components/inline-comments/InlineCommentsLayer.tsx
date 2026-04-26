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
  /** Used as a re-measure trigger: bumps when the rendered HTML swaps. */
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  blockRanges: Map<string, BlockSourceRange>;
  canComment: boolean;
  /**
   * When true, each card sticks at the viewport top while scroll passes
   * through its slot's range, and hands off smoothly to the next card.
   * When false, cards sit at their anchor and scroll with the doc.
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

  // ----- positioning -----
  // Each card lives inside a slot that is `position: absolute; top:
  // <anchor>` and tall enough to span up to the next card's anchor.
  // The card itself has `position: sticky; top: <pad>`, so the
  // browser handles all the scroll-time behavior natively (no JS in
  // the scroll loop, no compositor-vs-main-thread race):
  //   - While viewport is above the slot: card sits at slot top
  //     (= its anchor), scrolling normally with the document.
  //   - While viewport is inside the slot's range: card sticks at
  //     viewport top.
  //   - As the slot's bottom approaches viewport top: the card is
  //     pushed up by the slot's end, scrolling out of view just as
  //     the next slot's natural position arrives at the top. The
  //     handoff is continuous.

  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const naturalTops = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);

  const [layoutVersion, setLayoutVersion] = useState(0);
  const [columnHeight, setColumnHeight] = useState<number>(0);

  const requestRemeasure = useCallback(() => {
    setLayoutVersion((n) => n + 1);
  }, []);

  /**
   * Recompute every card's anchor position from the rendered doc, plus
   * the column's overall height. Slot top/height values used in render
   * are derived from these refs.
   */
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
      }
    }
    setColumnHeight((prev) => (Math.abs(prev - maxBottom) > 0.5 ? maxBottom : prev));
  }, [renderItems, docElementRef, scrollContainerRef]);

  // Stable per-id ref callbacks. Inline arrow refs would be a fresh
  // function each render and cause React to detach+reattach every time.
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
  // slot's min-height keeps the card from clipping when the user
  // expands/edits/replies.
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

  // Window resize → re-measure (the gutter width depends on viewport).
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

  // Layout effect: refresh heights from offsetHeight before measuring
  // naturals so the very first paint uses real values rather than the
  // stub default.
  useLayoutEffect(() => {
    for (const [id, el] of cardEls.current) {
      const h = el.offsetHeight;
      if (h > 0) cardHeights.current.set(id, h);
    }
    measureNaturalTops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureNaturalTops, layoutVersion, docHtml]);

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

  // Slot height for each card: spans up to the next card's anchor (so
  // sticky behavior runs through the gap), with a floor at the card's
  // own height (so the card always fits).
  const slots = useMemo(() => {
    return renderItems.map((item, i) => {
      const top = naturalTops.current.get(item.id) ?? 0;
      const next = renderItems[i + 1];
      const nextTop = next
        ? (naturalTops.current.get(next.id) ?? columnHeight)
        : columnHeight;
      const cardHeight = cardHeights.current.get(item.id) ?? 96;
      const height = Math.max(nextTop - top, cardHeight);
      return { item, top, height };
    });
    // layoutVersion / columnHeight in deps to recompute when measurements change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderItems, columnHeight, layoutVersion]);

  const showEmpty = sorted.length === 0 && !pendingAnchor;
  const minHeight = Math.max(columnHeight, 0);

  return (
    <aside
      ref={rootRef}
      className={`ic-column${stackingEnabled ? '' : ' ic-column-no-stacking'}`}
      aria-label="Inline comments"
      style={{ minHeight: `${minHeight}px` }}
    >
      {slots.map(({ item, top, height }) => (
        <div
          key={item.id}
          className="ic-anchor-slot"
          style={{ top: `${top}px`, height: `${height}px` }}
        >
          <div ref={getRefCallback(item.id)} className="ic-sticky-card">
            {renderCardById(item.id)}
          </div>
        </div>
      ))}

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
