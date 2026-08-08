import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DotsHorizontalIcon,
} from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback, useMemo } from 'react';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import { isProposal, type Thread } from '../../lib/api.js';
import {
  AT_THREAD_TOLERANCE_PX,
  adjacentThreadTarget,
  sortThreadTopEntries,
  type ThreadTopEntry,
} from './floatingCardPosition.js';
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
): string | null {
  if (!openId) return null;
  const entry = entries.find((e) => e.id === openId);
  if (!entry) return null;
  if (Math.abs(entry.top) <= AT_THREAD_TOLERANCE_PX) return openId;
  const maxScroll = scroll.scrollHeight - scroll.clientHeight;
  if (entry.top > 0 && scroll.scrollTop >= maxScroll - AT_THREAD_TOLERANCE_PX) return openId;
  if (entry.top < 0 && scroll.scrollTop <= AT_THREAD_TOLERANCE_PX) return openId;
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

  const jump = useCallback(
    (direction: -1 | 1) => {
      const doc = docElementRef.current;
      const scroll = scrollContainerRef.current;
      if (!doc || !scroll) return;
      const containerTop = scroll.getBoundingClientRect().top;

      // Measured on demand — no continuous anchor tracking in floating
      // mode, so build the document-order list at click time. Resolved
      // the same way the jump itself resolves its target, so these tops
      // are exactly where a jump would land.
      const entries: ThreadTopEntry[] = [];
      for (const thread of visibleThreads) {
        const blockId = thread.anchor.block_id;
        if (!blockId) continue;
        const el = resolveThreadScrollTarget(doc, blockId, thread.anchor.quote, thread.id);
        if (!el) continue;
        entries.push({
          id: thread.id,
          top: el.getBoundingClientRect().top - containerTop,
          startOffset: isProposal(thread) ? 0 : (thread.anchor.start_offset ?? 0),
          createdAt: thread.comments[0].created_at,
        });
      }
      sortThreadTopEntries(entries);

      const targetId = adjacentThreadTarget(
        entries,
        NAV_REF_TOP_PX,
        direction,
        parkedThreadId(entries, currentThreadId, scroll),
      );
      if (targetId) onOpenThread(targetId);
    },
    [visibleThreads, docElementRef, scrollContainerRef, currentThreadId, onOpenThread],
  );

  const count = visibleThreads.length;
  const countLabel = count === 1 ? '1 thread' : `${count} threads`;

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
