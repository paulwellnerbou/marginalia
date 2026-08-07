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

  /** The scrollTop a jump to this thread lands at, or null when its
   *  anchor doesn't resolve (orphans) — measured fresh from the DOM,
   *  mirroring scrollToAnchor's own targeting. */
  const jumpScrollTop = useCallback(
    (thread: Thread): number | null => {
      const scroll = scrollContainerRef.current;
      const doc = docElementRef.current;
      if (!scroll || !doc) return null;
      const blockId = thread.anchor.block_id;
      if (!blockId) return null;
      const target = resolveThreadScrollTarget(doc, blockId, thread.anchor.quote, thread.id);
      if (!target) return null;
      const top =
        target.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        scroll.scrollTop -
        (stackingEnabled ? 0 : stickyTopPad);
      return Math.max(0, Math.min(top, scroll.scrollHeight - scroll.clientHeight));
    },
    [scrollContainerRef, docElementRef, stackingEnabled, stickyTopPad],
  );

  /** The thread an arrow press should jump to, sharing its stepping
   *  rules with the floating toolbar so both presentations navigate the
   *  same way. */
  const navTarget = useCallback(
    (direction: -1 | 1): Thread | null => {
      const scroll = scrollContainerRef.current;
      if (!scroll) return null;
      const pos = scroll.scrollTop;

      // Threads whose anchor no longer resolves are left out: jumping to
      // them would silently do nothing and the arrow would feel dead.
      const entries: ThreadTopEntry[] = [];
      for (const thread of sortedThreads) {
        const want = jumpScrollTop(thread);
        if (want === null) continue;
        entries.push({ id: thread.id, top: want - pos });
      }
      // Already in document order; the sort is stable, so threads whose
      // landing positions tie (same anchor, or both clamped at an end of
      // the document) keep it.
      sortThreadTopEntries(entries);

      const remembered = lastNavThreadRef.current;
      const parked = entries.find(
        (e) => e.id === remembered && Math.abs(e.top) <= AT_THREAD_TOLERANCE_PX,
      );
      const targetId = adjacentThreadTarget(entries, NEAR_EPSILON_PX, direction, parked?.id);
      return sortedThreads.find((t) => t.id === targetId) ?? null;
    },
    [sortedThreads, scrollContainerRef, jumpScrollTop, lastNavThreadRef],
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
