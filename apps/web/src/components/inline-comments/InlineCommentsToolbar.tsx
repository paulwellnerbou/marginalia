import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DotsHorizontalIcon,
} from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import type { Thread } from '../../lib/api.js';
import {
  AT_THREAD_TOLERANCE_PX,
  adjacentThreadTarget,
  currentThreadIndex,
  sortThreadTopEntries,
  type ThreadTopEntry,
} from './floatingCardPosition.js';
import { threadCountLabel } from './inlineUtils.js';

interface Props {
  /** Threads in document order (already sorted, already filtered for visibility). */
  sortedThreads: Thread[];
  /** Doc-scroll container — used to read current scrollTop. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Rendered article root — anchors are measured fresh against it on
   *  each press, so late reflows (fonts, images) can't desync the nav. */
  docElementRef: RefObject<HTMLElement | null>;
  /** Thread the last navigation targeted (shared with card jumps / ref
   *  links). Next/prev step from it while the viewport is still there —
   *  scroll position alone can't tell apart threads on the same text. */
  lastNavThreadRef: { current: string | null };
  /** Effective sticky-top offset (base pad + toolbar height) — in
   *  non-stacking mode jumps land the anchor this far below the top. */
  stickyTopPad: number;
  /** Bumped by the column whenever anchors may have moved (reflow, font
   *  swap, card resize). Invalidates the measured landing positions the
   *  position readout follows while scrolling. */
  layoutVersion: number;
  open: boolean;
  onToggleOpen: () => void;
  stackingEnabled: boolean;
  onToggleStacking: () => void;
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  /** Switch the comment presentation from the margin column to floating cards. */
  onSwitchToFloating: () => void;
  /** Reuse the existing scrollToAnchor flow so jumps share the flash animation. */
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
  /** Receives the toolbar's outer element so the layer can measure its height. */
  rootRef: RefObject<HTMLDivElement | null>;
}

const NEAR_EPSILON_PX = 4;

export function InlineCommentsToolbar({
  sortedThreads,
  scrollContainerRef,
  docElementRef,
  lastNavThreadRef,
  stickyTopPad,
  layoutVersion,
  open,
  onToggleOpen,
  stackingEnabled,
  onToggleStacking,
  hideResolved,
  onToggleHideResolved,
  onSwitchToFloating,
  onScrollToAnchor,
  rootRef,
}: Props) {
  const hasThreads = sortedThreads.length > 0;

  /** Thread the readout names, by id — threads come and go, and an id
   *  that no longer exists simply falls back to the plain count. */
  const [currentId, setCurrentId] = useState<string | null>(null);

  const jumpTo = useCallback(
    (thread: Thread) => {
      const blockId = thread.anchor.block_id;
      if (!blockId) return;
      lastNavThreadRef.current = thread.id;
      // Name the destination straight away: the scroll animates over
      // several frames and the readout would otherwise trail the press.
      setCurrentId(thread.id);
      onScrollToAnchor(blockId, thread.anchor.quote, thread.id);
    },
    [onScrollToAnchor, lastNavThreadRef],
  );

  /** The scroll position a jump to each thread would land on — measured
   *  fresh from the DOM, mirroring scrollToAnchor's own targeting, so
   *  late reflows can't desync the nav. The container's own metrics are
   *  read once for the whole sweep; each thread costs one lookup and one
   *  rect. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion is the explicit re-measure trigger — the body reads a DOM that only it knows has moved.
  const measureLandings = useCallback((): ThreadTopEntry[] => {
    const scroll = scrollContainerRef.current;
    const doc = docElementRef.current;
    if (!scroll || !doc) return [];
    const pos = scroll.scrollTop;
    const containerTop = scroll.getBoundingClientRect().top;
    const maxScroll = scroll.scrollHeight - scroll.clientHeight;
    const pad = stackingEnabled ? 0 : stickyTopPad;

    // Threads whose anchor no longer resolves are left out: jumping to
    // them would silently do nothing and the arrow would feel dead.
    const entries: ThreadTopEntry[] = [];
    for (const thread of sortedThreads) {
      const blockId = thread.anchor.block_id;
      if (!blockId) continue;
      const target = resolveThreadScrollTarget(doc, blockId, thread.anchor.quote, thread.id);
      if (!target) continue;
      // Clamped like the scroll itself, so a thread it can get no closer
      // to reads as one the reader is already standing on.
      const want = Math.min(
        Math.max(target.getBoundingClientRect().top - containerTop + pos - pad, 0),
        maxScroll,
      );
      entries.push({ id: thread.id, top: want });
    }
    // Already in document order; the sort is stable, so threads whose
    // landing positions tie (same anchor, or both clamped at an end of
    // the document) keep it.
    return sortThreadTopEntries(entries);
  }, [
    sortedThreads,
    scrollContainerRef,
    docElementRef,
    stackingEnabled,
    stickyTopPad,
    layoutVersion,
  ]);

  /** Landing positions relative to the current scroll — where the nav
   *  reasons: 0 means the reader is standing on the thread, negative
   *  that they have scrolled past it. */
  const threadOffsets = useCallback((): ThreadTopEntry[] => {
    const pos = scrollContainerRef.current?.scrollTop ?? 0;
    return measureLandings().map((entry) => ({ ...entry, top: entry.top - pos }));
  }, [measureLandings, scrollContainerRef]);

  /** The same measurement, taken once and reused until something can
   *  have moved an anchor: the readout follows every scroll frame, and
   *  re-resolving every anchor that often is DOM work per frame that
   *  grows with the thread count. A fresh closure — hence a fresh cache
   *  — comes with each new `measureLandings`. */
  const cachedLandings = useMemo(() => {
    let cache: ThreadTopEntry[] | null = null;
    return () => {
      cache ??= measureLandings();
      return cache;
    };
  }, [measureLandings]);

  /** Which thread the reader is on, decided by the rules the arrows step
   *  by, so the readout and the next press can't disagree. */
  const updatePosition = useCallback(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const entries = cachedLandings();
    const pos = scroll.scrollTop;
    const remembered = lastNavThreadRef.current;
    const parked = entries.find(
      (e) => e.id === remembered && Math.abs(e.top - pos) <= AT_THREAD_TOLERANCE_PX,
    );
    // Entries are in document space, so the reading line moves with the
    // scroll instead of the entries being rebased onto it.
    const index = currentThreadIndex(entries, pos + NEAR_EPSILON_PX, parked?.id);
    setCurrentId(entries[index]?.id ?? null);
  }, [cachedLandings, scrollContainerRef, lastNavThreadRef]);

  // Follow the reading position so the readout tracks plain scrolling
  // too, not only arrow presses. Re-running also re-measures, and the
  // effect's dependencies change exactly when an anchor could have
  // moved. Coalesced into one recomputation per frame — scroll events
  // fire faster than the display refreshes on macOS/iOS.
  useEffect(() => {
    if (!open) return;
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    updatePosition();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updatePosition();
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      scroll.removeEventListener('scroll', onScroll);
    };
  }, [open, scrollContainerRef, updatePosition]);

  /** The thread an arrow press should jump to, sharing its stepping
   *  rules with the floating toolbar so both presentations navigate the
   *  same way. */
  const navTarget = useCallback(
    (direction: -1 | 1): Thread | null => {
      const entries = threadOffsets();
      const remembered = lastNavThreadRef.current;
      const parked = entries.find(
        (e) => e.id === remembered && Math.abs(e.top) <= AT_THREAD_TOLERANCE_PX,
      );
      const targetId = adjacentThreadTarget(entries, NEAR_EPSILON_PX, direction, parked?.id);
      return sortedThreads.find((t) => t.id === targetId) ?? null;
    },
    [threadOffsets, sortedThreads, lastNavThreadRef],
  );

  const onJumpPrev = useCallback(() => {
    const target = navTarget(-1);
    if (target) jumpTo(target);
  }, [navTarget, jumpTo]);

  const onJumpNext = useCallback(() => {
    const target = navTarget(1);
    if (target) jumpTo(target);
  }, [navTarget, jumpTo]);

  const count = sortedThreads.length;
  // Positioned within the full column, not within the measured entries:
  // a thread whose anchor no longer resolves is counted in the total, so
  // ranking against anything shorter would name the wrong number.
  const currentIndex = currentId ? sortedThreads.findIndex((t) => t.id === currentId) : -1;
  const countLabel = threadCountLabel(count, currentIndex);

  return (
    <div
      ref={rootRef}
      className={`ic-toolbar${open ? '' : ' ic-toolbar-collapsed'}`}
      role="toolbar"
      aria-label="Comment column actions"
    >
      <div className="ic-toolbar-group ic-toolbar-group-left">
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="ic-toolbar-collapse"
          onClick={onToggleOpen}
          aria-label={open ? 'Hide comments' : 'Show comments'}
          aria-expanded={open}
          title={open ? 'Hide comments' : 'Show comments'}
        >
          {open ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          {!open && <ChatBubbleIcon className="ic-toolbar-collapse-comment-icon" />}
        </IconButton>
      </div>
      <div className="ic-toolbar-main" aria-hidden={!open}>
        <span className="ic-toolbar-count" aria-live="polite">
          {countLabel}
        </span>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={onJumpPrev}
          disabled={!hasThreads}
          aria-label="Jump to previous comment"
          title="Jump to previous comment"
        >
          <ChevronUpIcon />
        </IconButton>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={onJumpNext}
          disabled={!hasThreads}
          aria-label="Jump to next comment"
          title="Jump to next comment"
        >
          <ChevronDownIcon />
        </IconButton>
      </div>
      <div className="ic-toolbar-group ic-toolbar-group-right">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              className="doc-toolbar-toggle"
              aria-label="Comment display options"
              title="Comment display options"
            >
              <DotsHorizontalIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.CheckboxItem
              checked={!hideResolved}
              onCheckedChange={onToggleHideResolved}
            >
              Show resolved
            </DropdownMenu.CheckboxItem>
            <DropdownMenu.CheckboxItem checked={stackingEnabled} onCheckedChange={onToggleStacking}>
              Stack comments at top
            </DropdownMenu.CheckboxItem>
            {/* One-shot mode switch, not a checkbox: this toolbar only
                exists in column mode, so a checked state could never
                render. */}
            <DropdownMenu.Item onSelect={onSwitchToFloating}>
              Float comments over text
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
