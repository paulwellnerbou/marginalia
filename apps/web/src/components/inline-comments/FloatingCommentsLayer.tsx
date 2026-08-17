import { Cross2Icon } from '@radix-ui/react-icons';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import type { CommentAnchor, Thread } from '../../lib/api.js';
import { FloatingCardGrip } from './FloatingCardGrip.js';
import { InlineThreadCard } from './InlineThreadCard.js';
import {
  COMMENT_FLASH_MS,
  type ThreadActionResult,
  threadLinks,
  threadsById,
} from './inlineUtils.js';
import { computeAnchoredThreadNesting, nestedThreadsOf } from './threadNesting.js';
import { type ThreadRefApi, threadRefIndex } from './threadRefs.js';
import { useFloatingCardDrag } from './useFloatingCardDrag.js';
import { useFloatingCardPlacement } from './useFloatingCardPlacement.js';

interface Props {
  uid: string;
  threads: Thread[];
  /** Re-position trigger: the rendered document was swapped. */
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  canComment: boolean;
  /**
   * Only as a "a draft is being written" signal — the composer itself
   * is `PendingCommentPopover`, mounted alongside this layer.
   */
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number; scroll: boolean } | null;
  displayName: string | null;
  mentionCandidates: string[];
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
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
}

/** Pointer travel beyond this is a scroll/drag, not a dismissing tap. */
const TAP_SLOP_PX = 9;

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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState<{ id: string; phase: 'a' | 'b' } | null>(null);
  // Seeded with the current nonce so remounting (mode toggle) doesn't
  // replay a focus signal that was already handled before the switch.
  const lastNonce = useRef<number | null>(focusedThread?.nonce ?? null);
  /** Scroll the card into view once, after the next successful placement. */
  const scrollToCardPending = useRef(false);

  const byId = useMemo(() => threadsById(threads), [threads]);

  /**
   * Merge each proposal into the card of the thread it answers, as the
   * margin column and the list pane do. Only one card is open at a
   * time here, so nesting also decides which card an id opens: a
   * proposal that renders inside another thread has no card of its
   * own, and opening it means opening the card it lives in.
   */
  const nesting = useMemo(() => computeAnchoredThreadNesting(threads), [threads]);
  const cardIdFor = useCallback(
    (threadId: string) => nesting.parentOf.get(threadId) ?? threadId,
    [nesting],
  );

  const openThread = openId ? (byId.get(openId) ?? null) : null;

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
    setOpenId(null);
  }, []);

  /** Jump to a linked thread: flash its anchor and swap the popover to it. */
  const focusLinked = useCallback(
    (target: Thread) => {
      const blockId = target.anchor.block_id;
      if (blockId) onScrollToAnchor(blockId, target.anchor.quote, target.id);
      setOpenId(cardIdFor(target.id));
    },
    [onScrollToAnchor, cardIdFor],
  );

  const threadRefs = useMemo<ThreadRefApi>(() => {
    const index = threadRefIndex(threads);
    return { resolve: (id) => index.get(id) ?? null, focus: focusLinked };
  }, [threads, focusLinked]);

  // The composer popover opens over the same text this one hangs off,
  // so yield the space to it — two cards on one anchor read as a bug.
  useEffect(() => {
    if (canComment && pendingAnchor) setOpenId(null);
  }, [canComment, pendingAnchor]);

  // Close when the open thread disappears (deleted, or the doc refresh
  // dropped it), and re-point at the parent card if a refresh turned the
  // open thread into a nested one — `openId` must always name a card
  // that renders, or the popover would go blank.
  useEffect(() => {
    setOpenId((cur) => {
      if (!cur) return cur;
      if (!threads.some((t) => t.id === cur)) return null;
      return cardIdFor(cur);
    });
  }, [threads, cardIdFor]);

  // Focus signal from DocumentLayout — highlight clicks, activity list,
  // deep links, toolbar navigation. Opens the popover and flashes it.
  // While a draft is being written the signal is consumed but ignored:
  // retargeting the popover slot would silently destroy the draft.
  useEffect(() => {
    if (!focusedThread) return;
    if (lastNonce.current === focusedThread.nonce) return;
    lastNonce.current = focusedThread.nonce;

    if (pendingAnchor || cardHasDraftText()) return;
    if (!threads.some((t) => t.id === focusedThread.threadId)) return;

    // Flash whichever card actually opens: targeting a nested proposal
    // opens the card it lives in, and `flashPhase` is that card's prop.
    const cardId = cardIdFor(focusedThread.threadId);
    setOpenId(cardId);
    if (focusedThread.scroll) scrollToCardPending.current = true;
    setFlash({ id: cardId, phase: focusedThread.nonce % 2 === 0 ? 'b' : 'a' });
  }, [focusedThread, threads, pendingAnchor, cardHasDraftText, cardIdFor]);

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
   * block.
   */
  const resolveOpenAnchorEl = useCallback((): HTMLElement | null => {
    const doc = docElementRef.current;
    if (!doc || !openId) return null;
    // A thread quoting the same range as another merges into that
    // range's mark, which carries only one thread id on the singular
    // attribute — an exact match here would miss every other thread in
    // the merge and fall through to the coarse block-level anchor.
    // `resolveThreadScrollTarget` checks the mark's full id list instead,
    // so this always agrees with where the jump itself landed.
    const thread = byId.get(openId);
    if (thread?.anchor.block_id) {
      return resolveThreadScrollTarget(doc, thread.anchor.block_id, thread.anchor.quote, openId);
    }
    return null;
  }, [docElementRef, openId, byId]);

  const pos = useFloatingCardPlacement({
    cardEl,
    hostRef,
    scrollContainerRef,
    docElementRef,
    resolveAnchorEl: resolveOpenAnchorEl,
    resetKey: openId,
    repositionKeys: [docHtml, threads],
  });

  const drag = useFloatingCardDrag({
    cardEl,
    hostRef,
    scrollContainerRef,
    pos,
    resetKey: openId,
  });

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

  // Move focus into the popover when a thread opens. Waits for a
  // measured position: the card is visibility:hidden until then, and
  // hidden elements silently refuse focus. The ref keeps later
  // repositions from re-stealing it.
  const focusedForOpenId = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || !cardEl || !pos) return;
    if (focusedForOpenId.current === openId) return;
    focusedForOpenId.current = openId;
    if (!cardEl.contains(document.activeElement)) {
      cardEl.focus({ preventScroll: true });
    }
  }, [openId, cardEl, pos]);

  // Hand focus back to the thread's highlight when the popover goes
  // away — otherwise keyboard users are dropped to <body>.
  useEffect(() => {
    if (!openId || !cardEl) return;
    const threadId = openId;
    return () => {
      if (focusedForOpenId.current === threadId) focusedForOpenId.current = null;
      const active = document.activeElement;
      const focusWasInside = active === document.body || (active && cardEl.contains(active));
      if (!focusWasInside) return;
      // Queried straight off the DOM rather than through the thread
      // list: depending on that list here would re-run this effect on
      // every refresh, and the cleanup would pull focus out of a card
      // that is still open. Overlapping quotes merge into one mark that
      // names only one thread on the singular attribute, so the merged
      // id list has to be matched too.
      const mark = docElementRef.current?.querySelector<HTMLElement>(
        `mark[data-comment-thread-ids~="${CSS.escape(threadId)}"], [data-comment-thread-id="${CSS.escape(threadId)}"]`,
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
  // menus, toolbars, other panes — never dismiss. A card holding draft
  // text is exempt so a stray tap can't discard unsent work.
  useEffect(() => {
    if (!openId) return;
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
    if (!openId) return;
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

  function renderCard(
    thread: Thread,
    nested: readonly Thread[],
    parentId: string | null,
  ): ReactNode {
    const blockId = thread.anchor.block_id;
    const onJump = blockId
      ? () => onScrollToAnchor(blockId, thread.anchor.quote, thread.id)
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
        focused={false}
        flashPhase={flash?.id === thread.id ? flash.phase : null}
        collapsed={false}
        mentionCandidates={mentionCandidates}
        onToggleCollapsed={() => {}}
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

  return (
    <div ref={hostRef} className="ic-float-host">
      {openThread && (
        <div
          ref={setCardEl}
          className={`ic-float-card${drag.dragging ? ' ic-float-card-dragging' : ''}`}
          role="dialog"
          aria-label="Comment thread"
          tabIndex={-1}
          style={
            pos
              ? { top: `${pos.top + drag.offset.dy}px`, left: `${pos.left + drag.offset.dx}px` }
              : { top: 0, left: 0, visibility: 'hidden' }
          }
        >
          <FloatingCardGrip drag={drag} label="Move this comment card" />
          <button
            type="button"
            className="ic-float-close"
            onClick={close}
            aria-label="Close comment thread"
            title="Close"
          >
            <Cross2Icon aria-hidden="true" />
          </button>
          {renderCard(openThread, nestedThreadsOf(nesting, openThread.id), null)}
        </div>
      )}
    </div>
  );
}
