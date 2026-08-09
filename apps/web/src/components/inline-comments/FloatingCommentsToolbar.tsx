import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DotsHorizontalIcon,
} from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import { isProposal, type Thread } from '../../lib/api.js';
import {
  AT_THREAD_TOLERANCE_PX,
  adjacentThreadTarget,
  currentThreadIndex,
  sortThreadTopEntries,
  type ThreadTopEntry,
} from './floatingCardPosition.js';
import { threadCountLabel } from './inlineUtils.js';
import { computeAnchoredThreadNesting } from './threadNesting.js';

interface Props {
  /** Already filtered for visibility by the layout — the cards these navigate to. */
  threads: Thread[];
  /** State of the "Show resolved" switch this toolbar offers; the
   *  filtering itself happens upstream, in the layout. */
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  /** Leave floating mode, back to the margin column. */
  onSwitchToColumn: () => void;
  /** False once the doc pane is too narrow for the column to render — the
   *  switch is left out rather than offered as a no-op. */
  columnModeAvailable: boolean;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Thread whose card is currently open, or null. Prev/next step from
   *  it while the reader is still parked there — threads quoting the
   *  same text share a position, so position alone can't tell them
   *  apart. */
  currentThreadId: string | null;
  /** Scrolls to the thread's anchor and opens its popover. */
  onOpenThread: (threadId: string) => void;
}

/**
 * Anchors at or above this line below the container's top edge count
 * as "already read" for prev/next navigation. Matches the column
 * toolbar's near-epsilon feel without a sticky stack to pad for.
 */
const NAV_REF_TOP_PX = 20;

/**
 * The open thread if the reader is still parked where the jump to it
 * left them, else null.
 *
 * A jump scrolls the thread's anchor to the container's top edge, so
 * sitting at that edge means the reader hasn't moved on. At either end
 * of the document the scroll clamps and the anchor stops short of the
 * edge — there, being at the scroll limit is what says the jump landed.
 */
function parkedThreadId(
  entries: ThreadTopEntry[],
  openId: string | null,
  scroll: HTMLElement,
  readerTop = 0,
): string | null {
  if (!openId) return null;
  const entry = entries.find((e) => e.id === openId);
  if (!entry) return null;
  const offset = entry.top - readerTop;
  if (Math.abs(offset) <= AT_THREAD_TOLERANCE_PX) return openId;
  const maxScroll = scroll.scrollHeight - scroll.clientHeight;
  if (offset > 0 && scroll.scrollTop >= maxScroll - AT_THREAD_TOLERANCE_PX) return openId;
  if (offset < 0 && scroll.scrollTop <= AT_THREAD_TOLERANCE_PX) return openId;
  return null;
}

/**
 * Compact floating toolbar for floating-comments mode. The margin
 * column (and its toolbar) is gone in this mode, so this pill carries
 * the thread count, prev/next navigation and the display options —
 * including the way back to column mode.
 */
export function FloatingCommentsToolbar({
  threads,
  hideResolved,
  onToggleHideResolved,
  onSwitchToColumn,
  columnModeAvailable,
  docElementRef,
  scrollContainerRef,
  currentThreadId,
  onOpenThread,
}: Props) {
  /**
   * Only threads that own a card are navigable: a proposal answering a
   * comment usually renders inside that comment's card, so stepping
   * onto it would re-open the card the reader is already looking at and
   * prev/next would read as doing nothing. Nested exactly the way
   * `FloatingCommentsLayer` nests, or the count and the arrows would
   * disagree with the cards the popover actually opens.
   */
  const visibleThreads = useMemo(() => computeAnchoredThreadNesting(threads).topLevel, [threads]);

  /** Threads the DOM can actually navigate to, in navigation order.
   *  Seed from the visible cards so the first paint retains the old
   *  count; the first measurement removes any unresolvable anchors. */
  const [navigableIds, setNavigableIds] = useState<string[]>(() =>
    visibleThreads.map((thread) => thread.id),
  );
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  /**
   * Measure each navigable thread's anchor in document space. These
   * positions stay fixed during scrolling, so the hot path only has to
   * subtract scrollTop rather than resolve and measure every anchor on
   * every frame.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion is the explicit invalidation trigger for the DOM measurements read by this callback.
  const measureLandings = useCallback((): ThreadTopEntry[] => {
    const doc = docElementRef.current;
    const scroll = scrollContainerRef.current;
    if (!doc || !scroll) return [];
    const pos = scroll.scrollTop;
    const containerTop = scroll.getBoundingClientRect().top;

    const entries: ThreadTopEntry[] = [];
    for (const thread of visibleThreads) {
      const blockId = thread.anchor.block_id;
      if (!blockId) continue;
      const el = resolveThreadScrollTarget(doc, blockId, thread.anchor.quote, thread.id);
      if (!el) continue;
      entries.push({
        id: thread.id,
        top: el.getBoundingClientRect().top - containerTop + pos,
        startOffset: isProposal(thread) ? 0 : (thread.anchor.start_offset ?? 0),
        createdAt: thread.comments[0].created_at,
      });
    }
    return sortThreadTopEntries(entries);
  }, [visibleThreads, docElementRef, scrollContainerRef, layoutVersion]);

  /** Cache the DOM sweep until threads or observed layout change. */
  const cachedLandings = useMemo(() => {
    let cache: ThreadTopEntry[] | null = null;
    return () => {
      cache ??= measureLandings();
      return cache;
    };
  }, [measureLandings]);

  /** Rebase the cached document positions onto the current viewport. */
  const threadOffsets = useCallback((): ThreadTopEntry[] => {
    const pos = scrollContainerRef.current?.scrollTop ?? 0;
    return cachedLandings().map((entry) => ({ ...entry, top: entry.top - pos }));
  }, [cachedLandings, scrollContainerRef]);

  /** Keep the counter in step with plain scrolling, not only arrow presses. */
  const updatePosition = useCallback(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    const entries = cachedLandings();
    const pos = scroll.scrollTop;
    const parked = parkedThreadId(entries, currentThreadId, scroll, pos);
    const index = currentThreadIndex(entries, pos + NAV_REF_TOP_PX, parked);
    setCurrentId(entries[index]?.id ?? null);
  }, [cachedLandings, scrollContainerRef, currentThreadId]);

  useEffect(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return;
    setNavigableIds(cachedLandings().map((entry) => entry.id));
    updatePosition();

    let raf = 0;
    const requestUpdate = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updatePosition();
      });
    };

    scroll.addEventListener('scroll', requestUpdate, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      scroll.removeEventListener('scroll', requestUpdate);
    };
  }, [scrollContainerRef, cachedLandings, updatePosition]);

  /** Any document or viewport resize can move anchors. Invalidate the
   *  cached sweep; the effect above then measures once and refreshes
   *  both the navigation set and the readout. */
  useEffect(() => {
    const scroll = scrollContainerRef.current;
    const doc = docElementRef.current;
    if (!scroll) return;
    const resizeObserver = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
    if (doc) resizeObserver.observe(doc);
    resizeObserver.observe(scroll);
    return () => resizeObserver.disconnect();
  }, [scrollContainerRef, docElementRef]);

  const jump = useCallback(
    (direction: -1 | 1) => {
      const scroll = scrollContainerRef.current;
      if (!scroll) return;
      const entries = threadOffsets();

      const targetId = adjacentThreadTarget(
        entries,
        NAV_REF_TOP_PX,
        direction,
        parkedThreadId(entries, currentThreadId, scroll),
      );
      if (targetId) {
        // Name the destination immediately while its smooth scroll is
        // still in flight, matching the column toolbar's behaviour.
        setCurrentId(targetId);
        onOpenThread(targetId);
      }
    },
    [threadOffsets, scrollContainerRef, currentThreadId, onOpenThread],
  );

  const count = navigableIds.length;
  const currentIndex = currentId ? navigableIds.indexOf(currentId) : -1;
  const countLabel = threadCountLabel(count, currentIndex);

  return (
    <div className="ic-float-toolbar-popover">
      <div className="ic-float-toolbar" role="toolbar" aria-label="Floating comments actions">
        <ChatBubbleIcon className="ic-float-toolbar-icon" aria-hidden="true" />
        <span className="ic-toolbar-count" aria-live="polite">
          {countLabel}
        </span>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => jump(-1)}
          disabled={count === 0}
          aria-label="Jump to previous comment"
          title="Jump to previous comment"
        >
          <ChevronUpIcon />
        </IconButton>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={() => jump(1)}
          disabled={count === 0}
          aria-label="Jump to next comment"
          title="Jump to next comment"
        >
          <ChevronDownIcon />
        </IconButton>
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
            {/* One-shot mode switch, not a checkbox: this pill only
                exists in floating mode, so an unchecked state could
                never render. */}
            {columnModeAvailable && (
              <DropdownMenu.Item onSelect={onSwitchToColumn}>
                Show comments in a column
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
