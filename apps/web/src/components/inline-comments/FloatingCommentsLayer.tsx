import { Cross2Icon } from '@radix-ui/react-icons';
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
import type { CommentAnchor, Thread } from '../../lib/api.js';
import { computeFloatingCardPosition } from './floatingCardPosition.js';
import { InlineComposer } from './InlineComposer.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import { COMMENT_FLASH_MS, resolveAnchorElement, threadLinks, threadsById } from './inlineUtils.js';
import { type ThreadRefApi, threadRefIndex } from './threadRefs.js';

interface Props {
  uid: string;
  threads: Thread[];
  /** Re-position trigger: the rendered document was swapped. */
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  canComment: boolean;
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
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<boolean>;
  onRepairThread: (id: string) => Promise<boolean>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onEditProposal?: ((thread: Thread) => void) | undefined;
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
}

const PENDING_ID = '__pending__';
/** Fallback offset below the visible top edge for cards with no anchor. */
const ORPHAN_VIEW_OFFSET_PX = 16;
/** Pointer travel beyond this is a scroll/drag, not a dismissing tap. */
const TAP_SLOP_PX = 9;
/** Quiet time after the last scroll event before re-checking placement. */
const SCROLL_SETTLE_MS = 160;

/**
 * Floating presentation of comment threads: instead of a margin
 * column, one thread at a time opens as a popover card anchored to
 * its highlight, Apple-Books style. The card lives in content space
 * (inside the document row), so it scrolls with the text.
 */
export function FloatingCommentsLayer({
  uid,
  threads,
  docHtml,
  docElementRef,
  scrollContainerRef,
  canComment,
  pendingAnchor,
  focusedThread,
  displayName,
  mentionCandidates,
  onCancelPending,
  onCreate,
  onReply,
  onEdit,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onReact,
  onEditProposal,
  onScrollToAnchor,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);
  // Seeded with the current nonce so remounting (mode toggle) doesn't
  // replay a focus signal that was already handled before the switch.
  const lastNonce = useRef<number | null>(focusedThread?.nonce ?? null);
  /** Scroll the card into view once, after the next successful placement. */
  const scrollToCardPending = useRef(false);
  /** Latest placement pass, callable from observers/listeners. */
  const computeRef = useRef<(() => void) | null>(null);

  const byId = useMemo(() => threadsById(threads), [threads]);
  const openThread = openId && openId !== PENDING_ID ? (byId.get(openId) ?? null) : null;

  /**
   * A composer inside the card holds unsent text. Every implicit close
   * path (tap-away, Escape, focus signals) must refuse to unmount it —
   * composer drafts are component-local state and die with the card.
   */
  const cardHasDraftText = useCallback((): boolean => {
    if (!cardEl) return false;
    for (const field of cardEl.querySelectorAll('textarea')) {
      if (field.value.trim() !== '') return true;
    }
    return false;
  }, [cardEl]);

  const close = useCallback(() => {
    if (openId === PENDING_ID) {
      onCancelPending();
      return;
    }
    setOpenId(null);
  }, [openId, onCancelPending]);

  /** Jump to a linked thread: flash its anchor and swap the popover to it. */
  const focusLinked = useCallback(
    (target: Thread) => {
      const blockId = target.anchor.block_id;
      if (blockId) onScrollToAnchor(blockId, target.anchor.quote, target.id);
      setOpenId(target.id);
    },
    [onScrollToAnchor],
  );

  const threadRefs = useMemo<ThreadRefApi>(() => {
    const index = threadRefIndex(threads);
    return { resolve: (id) => index.get(id) ?? null, focus: focusLinked };
  }, [threads, focusLinked]);

  // The pending composer takes over the single popover slot while a
  // draft is active, and releases it when the draft is posted/cancelled.
  useEffect(() => {
    if (canComment && pendingAnchor) {
      setOpenId(PENDING_ID);
      return;
    }
    setOpenId((cur) => (cur === PENDING_ID ? null : cur));
  }, [canComment, pendingAnchor]);

  // Close when the open thread disappears (deleted, or the doc refresh
  // dropped it).
  useEffect(() => {
    setOpenId((cur) =>
      cur && cur !== PENDING_ID && !threads.some((t) => t.id === cur) ? null : cur,
    );
  }, [threads]);

  // Focus signal from DocumentLayout — highlight clicks, activity list,
  // deep links, toolbar navigation. Opens the popover and flashes it.
  // While a draft is being written the signal is consumed but ignored:
  // retargeting the popover slot would silently destroy the draft.
  useEffect(() => {
    if (!focusedThread) return;
    if (lastNonce.current === focusedThread.nonce) return;
    lastNonce.current = focusedThread.nonce;

    if (openId === PENDING_ID || cardHasDraftText()) return;
    if (!threads.some((t) => t.id === focusedThread.threadId)) return;

    setOpenId(focusedThread.threadId);
    if (focusedThread.scroll) scrollToCardPending.current = true;
    setFlash({ id: focusedThread.threadId, phase: focusedThread.nonce % 2 === 0 ? 'b' : 'a' });
  }, [focusedThread, threads, openId, cardHasDraftText]);

  // Separate from the focus effect: that one re-runs on openId changes,
  // and its cleanup would cancel the timer before the flash ends.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), COMMENT_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /**
   * The element the popover hangs off. Prefer the painted highlight
   * (exact line rect for range comments); fall back to the anchored
   * block. The pending draft's highlight is the only mark without a
   * thread id.
   */
  const resolveOpenAnchorEl = useCallback((): HTMLElement | null => {
    const doc = docElementRef.current;
    if (!doc || !openId) return null;
    if (openId === PENDING_ID) {
      const mark = doc.querySelector<HTMLElement>(
        'mark[data-comment-highlight]:not([data-comment-thread-id])',
      );
      if (mark) return mark;
      if (pendingAnchor?.block_id) {
        return resolveAnchorElement(doc, pendingAnchor.block_id, pendingAnchor.quote);
      }
      return null;
    }
    const highlight = doc.querySelector<HTMLElement>(
      `[data-comment-thread-id="${CSS.escape(openId)}"]`,
    );
    if (highlight) return highlight;
    const thread = byId.get(openId);
    if (thread?.anchor.block_id) {
      return resolveAnchorElement(doc, thread.anchor.block_id, thread.anchor.quote);
    }
    return null;
  }, [docElementRef, openId, pendingAnchor, byId]);

  // Reset the measured position whenever a different card opens so the
  // new card doesn't render at the previous card's coordinates first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openId keys which card the position belongs to.
  useLayoutEffect(() => {
    setPos(null);
  }, [openId]);

  // Place the card: measure the anchor and the card, compute a clamped
  // below/above position in host space. A passive effect on purpose —
  // RenderedDoc applies a new docHtml via passive effects earlier in
  // tree order, so by the time this runs the swapped DOM is measurable.
  // Re-fires on card resizes (reply composer opening, "Show more"),
  // host resizes (pane drags, doc reflow), window resizes, and any doc
  // mutation (highlight repaints, mermaid/image late layout).
  // biome-ignore lint/correctness/useExhaustiveDependencies: docHtml and threads are explicit re-position triggers for anchor movement after re-renders.
  useEffect(() => {
    if (!openId || !cardEl) return;

    const compute = () => {
      const host = hostRef.current;
      const scroll = scrollContainerRef.current;
      if (!host || !scroll) return;
      const hostRect = host.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      if (hostRect.width <= 0 || cardRect.width <= 0) return;
      const viewTop = scrollRect.top - hostRect.top;

      const anchorEl = resolveOpenAnchorEl();
      let next: { top: number; left: number };
      if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        const placed = computeFloatingCardPosition({
          anchorTop: anchorRect.top - hostRect.top,
          anchorBottom: anchorRect.bottom - hostRect.top,
          anchorLeft: anchorRect.left - hostRect.left,
          hostWidth: hostRect.width,
          cardWidth: cardRect.width,
          cardHeight: cardRect.height,
          viewTop,
          viewHeight: scroll.clientHeight,
        });
        next = { top: placed.top, left: placed.left };
      } else {
        // No anchor to hang off (orphaned thread): pin near the top of
        // the current view, centered.
        next = {
          top: Math.max(viewTop + ORPHAN_VIEW_OFFSET_PX, 0),
          left: Math.max((hostRect.width - cardRect.width) / 2, 0),
        };
      }

      setPos((prev) =>
        prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5
          ? prev
          : next,
      );
    };

    computeRef.current = compute;
    compute();

    const onResize = () => compute();
    window.addEventListener('resize', onResize);

    const observers: (ResizeObserver | MutationObserver)[] = [];
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => compute());
      ro.observe(cardEl);
      if (hostRef.current) ro.observe(hostRef.current);
      observers.push(ro);
    }
    // Coalesce doc-mutation bursts (highlight repaints, mermaid text→SVG
    // swaps, image loads) into one re-placement per frame — same pattern
    // as the column layer's remeasure observer.
    const doc = docElementRef.current;
    let raf = 0;
    if (doc && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          compute();
        });
      });
      mo.observe(doc, { childList: true, subtree: true, characterData: true });
      observers.push(mo);
    }

    return () => {
      if (computeRef.current === compute) computeRef.current = null;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const o of observers) o.disconnect();
    };
  }, [openId, cardEl, resolveOpenAnchorEl, scrollContainerRef, docElementRef, docHtml, threads]);

  // Placement decides below/above against the viewport at open time, so
  // a navigation that then smooth-scrolls to the anchor can leave the
  // card outside the view. Once scrolling settles, re-place — but only
  // when the card actually ended up off-screen, so ordinary reading
  // never nudges an on-screen card.
  useEffect(() => {
    if (!openId || !cardEl) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const scrollRect = scroll.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        const outOfView = cardRect.bottom < scrollRect.top || cardRect.top > scrollRect.bottom;
        if (outOfView) computeRef.current?.();
      }, SCROLL_SETTLE_MS);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [openId, cardEl, scrollContainerRef]);

  // Deferred scroll for focus signals that asked for it (deep links,
  // activity clicks): once the card has a position, bring it into view.
  useEffect(() => {
    if (!pos || !cardEl || !scrollToCardPending.current) return;
    scrollToCardPending.current = false;
    const frame = window.requestAnimationFrame(() => {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pos, cardEl]);

  // Move focus into the popover when a thread opens (the pending
  // composer autofocuses itself). Waits for a measured position: the
  // card is visibility:hidden until then, and hidden elements silently
  // refuse focus. The ref keeps later repositions from re-stealing it.
  const focusedForOpenId = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || openId === PENDING_ID || !cardEl || !pos) return;
    if (focusedForOpenId.current === openId) return;
    focusedForOpenId.current = openId;
    if (!cardEl.contains(document.activeElement)) {
      cardEl.focus({ preventScroll: true });
    }
  }, [openId, cardEl, pos]);

  // Hand focus back to the thread's highlight when the popover goes
  // away — otherwise keyboard users are dropped to <body>.
  useEffect(() => {
    if (!openId || openId === PENDING_ID || !cardEl) return;
    const threadId = openId;
    return () => {
      if (focusedForOpenId.current === threadId) focusedForOpenId.current = null;
      const active = document.activeElement;
      const focusWasInside = active === document.body || (active && cardEl.contains(active));
      if (!focusWasInside) return;
      const mark = docElementRef.current?.querySelector<HTMLElement>(
        `[data-comment-thread-id="${CSS.escape(threadId)}"]`,
      );
      if (!mark) return;
      // Resolved-thread highlights are painted without tabindex/role, so
      // focus() on them would silently no-op and strand focus on <body>.
      if (!mark.hasAttribute('tabindex')) mark.setAttribute('tabindex', '-1');
      mark.focus({ preventScroll: true });
    };
  }, [openId, cardEl, docElementRef]);

  // Tap-to-dismiss: a *tap* on the document text (not a scroll gesture,
  // not a drag, not a highlight — highlights re-target the popover via
  // their click handler) closes the card. Pointer travel beyond the
  // slop means scrolling; taps outside the scroll container — dialogs,
  // menus, toolbars, other panes — never dismiss. The pending composer
  // and any card holding draft text are exempt so a stray tap can't
  // discard unsent work.
  useEffect(() => {
    if (!openId || openId === PENDING_ID) return;
    let start: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      start = null;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardEl?.contains(target)) return;
      if (!scrollContainerRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[data-comment-highlight], [data-comment-highlight-block]')
      ) {
        return;
      }
      start = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!start) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      start = null;
      if (moved > TAP_SLOP_PX) return;
      if (cardHasDraftText()) return;
      setOpenId(null);
    };
    const onPointerCancel = () => {
      start = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
    };
  }, [openId, cardEl, scrollContainerRef, cardHasDraftText]);

  // Escape closes the popover — unless a Radix layer (diff dialog,
  // dropdown) already handled it, focus sits in one of the card's form
  // fields, or a composer holds draft text (explicit ✕ still closes).
  useEffect(() => {
    if (!openId || openId === PENDING_ID) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        cardEl?.contains(target) &&
        (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
      ) {
        return;
      }
      if (cardHasDraftText()) return;
      setOpenId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openId, cardEl, cardHasDraftText]);

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  function renderOpenCard(): ReactNode {
    if (openId === PENDING_ID) {
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
    if (!openThread) return null;
    const blockId = openThread.anchor.block_id;
    const onJump = blockId
      ? () => onScrollToAnchor(blockId, openThread.anchor.quote, openThread.id)
      : undefined;
    return (
      <InlineThreadCard
        uid={uid}
        thread={openThread}
        links={threadLinks(openThread, byId)}
        onFocusLinked={focusLinked}
        threadRefs={threadRefs}
        canComment={canComment}
        needsName={!displayName}
        focused={false}
        flashPhase={flash?.id === openThread.id ? flash.phase : null}
        collapsed={false}
        mentionCandidates={mentionCandidates}
        onToggleCollapsed={() => {}}
        onJump={onJump}
        onReply={onReply}
        onEdit={onEdit}
        onDeleteNode={onDeleteNode}
        onDeleteThread={onDeleteThread}
        onResolveThread={onResolveThread}
        onRepairThread={onRepairThread}
        onReact={onReact}
        onEditProposal={onEditProposal}
      />
    );
  }

  return (
    <div ref={hostRef} className="ic-float-host">
      {openId && (
        <div
          ref={setCardEl}
          className="ic-float-card"
          role="dialog"
          aria-label={openId === PENDING_ID ? 'New comment' : 'Comment thread'}
          tabIndex={-1}
          style={
            pos
              ? { top: `${pos.top}px`, left: `${pos.left}px` }
              : { top: 0, left: 0, visibility: 'hidden' }
          }
        >
          <button
            type="button"
            className="ic-float-close"
            onClick={close}
            aria-label={openId === PENDING_ID ? 'Discard comment draft' : 'Close comment thread'}
            title={openId === PENDING_ID ? 'Discard draft' : 'Close'}
          >
            <Cross2Icon aria-hidden="true" />
          </button>
          {renderOpenCard()}
        </div>
      )}
    </div>
  );
}
