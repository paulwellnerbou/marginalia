import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DotsHorizontalIcon,
} from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback, useMemo } from 'react';
import { resolveAnchorElement } from '../../lib/anchor-target.js';
import type { Thread } from '../../lib/api.js';
import { adjacentThreadTarget, type ThreadTopEntry } from './floatingCardPosition.js';

interface Props {
  threads: Thread[];
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  /** Leave floating mode, back to the margin column. */
  onSwitchToColumn: () => void;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
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
  docElementRef,
  scrollContainerRef,
  onOpenThread,
}: Props) {
  const visibleThreads = useMemo(
    () => (hideResolved ? threads.filter((t) => t.state !== 'resolved') : threads),
    [threads, hideResolved],
  );

  const jump = useCallback(
    (direction: -1 | 1) => {
      const doc = docElementRef.current;
      const scroll = scrollContainerRef.current;
      if (!doc || !scroll) return;
      const scrollTop = scroll.getBoundingClientRect().top;

      // Measured on demand — no continuous anchor tracking in floating
      // mode, so build the document-order list at click time.
      const entries: ThreadTopEntry[] = [];
      for (const thread of visibleThreads) {
        const blockId = thread.anchor.block_id;
        if (!blockId) continue;
        const el =
          doc.querySelector<HTMLElement>(`[data-comment-thread-id="${CSS.escape(thread.id)}"]`) ??
          resolveAnchorElement(doc, blockId, thread.anchor.quote);
        if (!el) continue;
        entries.push({ id: thread.id, top: el.getBoundingClientRect().top - scrollTop });
      }
      entries.sort((a, b) => a.top - b.top);

      const targetId = adjacentThreadTarget(entries, NAV_REF_TOP_PX, direction);
      if (targetId) onOpenThread(targetId);
    },
    [visibleThreads, docElementRef, scrollContainerRef, onOpenThread],
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
            <DropdownMenu.Item onSelect={onSwitchToColumn}>
              Show comments in a column
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
