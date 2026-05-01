import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LayersIcon,
} from '@radix-ui/react-icons';
import { IconButton } from '@radix-ui/themes';
import { type RefObject, useCallback } from 'react';
import type { Thread } from '../../lib/api.js';

interface Props {
  /** Threads in document order (already sorted, already filtered for visibility). */
  sortedThreads: Thread[];
  /** Doc-scroll container — used to read current scrollTop. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Map of natural top positions (in scroll-container coordinates) keyed by thread id. */
  cardNaturalTops: Map<string, number>;
  /** Effective sticky-top offset (base pad + toolbar height) — used so a card
   *  partly hidden under the toolbar still counts as "current," not "next". */
  stickyTopPad: number;
  stackingEnabled: boolean;
  onToggleStacking: () => void;
  hideResolved: boolean;
  onToggleHideResolved: () => void;
  /** Reuse the existing scrollToAnchor flow so jumps share the flash animation. */
  onScrollToAnchor: (blockId: string, quote?: string | null, threadId?: string) => void;
  /** Receives the toolbar's outer element so the layer can measure its height. */
  rootRef: RefObject<HTMLDivElement | null>;
}

const NEAR_EPSILON_PX = 4;

export function InlineCommentsToolbar({
  sortedThreads,
  scrollContainerRef,
  cardNaturalTops,
  stickyTopPad,
  stackingEnabled,
  onToggleStacking,
  hideResolved,
  onToggleHideResolved,
  onScrollToAnchor,
  rootRef,
}: Props) {
  const hasThreads = sortedThreads.length > 0;

  const jumpTo = useCallback(
    (thread: Thread) => {
      const blockId = thread.anchor.block_id;
      if (!blockId) return;
      onScrollToAnchor(blockId, thread.anchor.quote, thread.id);
    },
    [onScrollToAnchor],
  );

  /** Index of the topmost comment whose anchor is at or above the
   *  toolbar's bottom edge — i.e. the comment the reader is currently
   *  on. Returns -1 when no comment has been reached yet (scrolled
   *  above the first one). */
  const findCurrentIndex = useCallback((): number => {
    const scroll = scrollContainerRef.current;
    if (!scroll) return -1;
    const ref = scroll.scrollTop + stickyTopPad + NEAR_EPSILON_PX;
    let current = -1;
    for (let i = 0; i < sortedThreads.length; i++) {
      const t = sortedThreads[i];
      if (!t) continue;
      const top = cardNaturalTops.get(t.id);
      if (top === undefined) continue;
      if (top <= ref) current = i;
      else break;
    }
    return current;
  }, [sortedThreads, cardNaturalTops, scrollContainerRef, stickyTopPad]);

  const onJumpPrev = useCallback(() => {
    const idx = findCurrentIndex();
    // idx === -1: above the first comment → nothing to go prev to.
    // idx === 0: on the first comment → also nothing prev.
    // idx > 0: step back one.
    const target = idx > 0 ? sortedThreads[idx - 1] : null;
    if (target) jumpTo(target);
  }, [findCurrentIndex, sortedThreads, jumpTo]);

  const onJumpNext = useCallback(() => {
    const idx = findCurrentIndex();
    const target = sortedThreads[idx + 1];
    if (target) jumpTo(target);
  }, [findCurrentIndex, sortedThreads, jumpTo]);

  const count = sortedThreads.length;
  const countLabel = count === 1 ? '1 thread' : `${count} threads`;

  return (
    <div ref={rootRef} className="ic-toolbar" role="toolbar" aria-label="Comment column actions">
      <div className="ic-toolbar-group ic-toolbar-group-left">
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
      <span className="ic-toolbar-count" aria-live="polite">
        {countLabel}
      </span>
      <div className="ic-toolbar-group ic-toolbar-group-right">
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="doc-toolbar-toggle"
          onClick={onToggleHideResolved}
          aria-label={
            hideResolved
              ? 'Show resolved, accepted, and rejected threads'
              : 'Hide resolved, accepted, and rejected threads'
          }
          aria-pressed={hideResolved}
          title={
            hideResolved
              ? 'Show resolved, accepted, and rejected threads'
              : 'Hide resolved, accepted, and rejected threads'
          }
        >
          <CheckCircledIcon />
        </IconButton>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="doc-toolbar-toggle"
          onClick={onToggleStacking}
          aria-label={
            stackingEnabled ? 'Disable stacking' : 'Stack comments at top while scrolling'
          }
          aria-pressed={stackingEnabled}
          title={stackingEnabled ? 'Disable stacking' : 'Stack comments at top while scrolling'}
        >
          <LayersIcon />
        </IconButton>
      </div>
    </div>
  );
}
