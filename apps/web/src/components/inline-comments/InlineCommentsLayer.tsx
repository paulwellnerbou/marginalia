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

const PENDING_ID = '__pending__';
const CARD_GAP_PX = 8;
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

  // ----- anchor-aligned positioning -----

  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardHeights = useRef<Map<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const [positions, setPositions] = useState<Map<string, number>>(new Map());
  const [columnHeight, setColumnHeight] = useState<number>(0);
  const [measureNonce, setMeasureNonce] = useState(0);

  const requestMeasure = useCallback(() => {
    setMeasureNonce((n) => n + 1);
  }, []);

  // Wire a single ResizeObserver that watches every card's wrapper.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.cardId;
        if (!id) continue;
        const next = entry.contentRect.height;
        const prev = cardHeights.current.get(id);
        if (prev === undefined || Math.abs(prev - next) > 0.5) {
          cardHeights.current.set(id, next);
          changed = true;
        }
      }
      if (changed) requestMeasure();
    });
    observerRef.current = obs;
    for (const el of cardEls.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [requestMeasure]);

  const setCardRef = useCallback((id: string, el: HTMLDivElement | null) => {
    const map = cardEls.current;
    const prev = map.get(id);
    if (prev && prev !== el) {
      observerRef.current?.unobserve(prev);
    }
    if (el) {
      el.dataset.cardId = id;
      map.set(id, el);
      observerRef.current?.observe(el);
    } else {
      map.delete(id);
      cardHeights.current.delete(id);
    }
  }, []);

  // React to viewport resize.
  useEffect(() => {
    const handler = () => requestMeasure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [requestMeasure]);

  // React to DOM mutations inside the rendered article (block reflow,
  // mermaid SVG injection, image loads, etc).
  useEffect(() => {
    const doc = docElementRef.current;
    if (!doc || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => requestMeasure());
    obs.observe(doc, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [docElementRef, requestMeasure, docHtml]);

  // The actual measurement pass. Runs synchronously after layout so the
  // first paint already has the right `top` values — no flash.
  useLayoutEffect(() => {
    const doc = docElementRef.current;
    const scroll = scrollContainerRef.current;
    if (!doc || !scroll) return;

    const scrollRect = scroll.getBoundingClientRect();
    const scrollTop = scroll.scrollTop;

    type Measured = { id: string; anchorTop: number; height: number };
    const measured: Measured[] = [];

    function anchorTopFor(blockId: string | null): number {
      if (!blockId) return 0;
      const escaped = CSS.escape(blockId);
      const el = doc!.querySelector<HTMLElement>(
        `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
      );
      if (!el) return 0;
      return el.getBoundingClientRect().top - scrollRect.top + scrollTop;
    }

    if (canComment && pendingAnchor) {
      measured.push({
        id: PENDING_ID,
        anchorTop: anchorTopFor(pendingAnchor.block_id),
        height: cardHeights.current.get(PENDING_ID) ?? 140,
      });
    }

    for (const item of sorted) {
      measured.push({
        id: item.thread.id,
        anchorTop: anchorTopFor(item.thread.anchor.block_id),
        height: cardHeights.current.get(item.thread.id) ?? 96,
      });
    }

    measured.sort((a, b) => a.anchorTop - b.anchorTop);

    const next = new Map<string, number>();
    let cursor = 0;
    for (const m of measured) {
      const top = Math.max(m.anchorTop, cursor);
      next.set(m.id, top);
      cursor = top + m.height + CARD_GAP_PX;
    }

    setPositions((prev) => {
      if (prev.size === next.size) {
        let same = true;
        for (const [k, v] of next) {
          const pv = prev.get(k);
          if (pv === undefined || Math.abs(pv - v) > 0.5) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
    setColumnHeight((prev) => (Math.abs(prev - cursor) > 0.5 ? cursor : prev));
  }, [sorted, pendingAnchor, canComment, docElementRef, scrollContainerRef, measureNonce, docHtml]);

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
        <div
          ref={(el) => setCardRef(PENDING_ID, el)}
          className="ic-anchor-wrapper"
          style={{ top: `${positions.get(PENDING_ID) ?? 0}px` }}
        >
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
          <div
            key={id}
            ref={(el) => setCardRef(id, el)}
            className="ic-anchor-wrapper"
            style={{ top: `${positions.get(id) ?? 0}px` }}
          >
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
