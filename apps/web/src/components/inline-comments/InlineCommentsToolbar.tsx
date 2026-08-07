import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DotsHorizontalIcon,
} from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback } from 'react';
import { resolveThreadScrollTarget } from '../../lib/anchor-target.js';
import type { Thread } from '../../lib/api.js';
import {
  AT_THREAD_TOLERANCE_PX,
  adjacentThreadTarget,
  sortThreadTopEntries,
  type ThreadTopEntry,
} from './floatingCardPosition.js';

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

  const jumpTo = useCallback(
    (thread: Thread) => {
      const blockId = thread.anchor.block_id;
      if (!blockId) return;
      lastNavThreadRef.current = thread.id;
      onScrollToAnchor(blockId, thread.anchor.quote, thread.id);
    },
    [onScrollToAnchor, lastNavThreadRef],
  );

  /** Where each thread's anchor sits relative to the scroll position a
   *  jump to it would land on — measured fresh from the DOM, mirroring
   *  scrollToAnchor's own targeting, so late reflows can't desync the
   *  nav. The container's own metrics are read once for the whole sweep;
   *  each thread costs one lookup and one rect. */
  const threadOffsets = useCallback((): ThreadTopEntry[] => {
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
      entries.push({ id: thread.id, top: want - pos });
    }
    // Already in document order; the sort is stable, so threads whose
    // landing positions tie (same anchor, or both clamped at an end of
    // the document) keep it.
    return sortThreadTopEntries(entries);
  }, [sortedThreads, scrollContainerRef, docElementRef, stackingEnabled, stickyTopPad]);

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
  const countLabel = count === 1 ? '1 thread' : `${count} threads`;

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
