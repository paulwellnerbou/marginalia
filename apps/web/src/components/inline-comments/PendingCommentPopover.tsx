import { Cross2Icon } from '@radix-ui/react-icons';
import { type RefObject, useCallback, useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import { resolveAnchorElement } from '../../lib/anchor-target.js';
import type { CommentAnchor } from '../../lib/api.js';
import { InlineComposer } from './InlineComposer.js';
import { useFloatingCardPlacement } from './useFloatingCardPlacement.js';

interface Props {
  anchor: CommentAnchor;
  /** Re-position trigger: the rendered document was swapped. */
  docHtml: string;
  docElementRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  displayName: string | null;
  mentionCandidates: string[];
  onCancel: () => void;
  onCreate: (payload: {
    anchor: CommentAnchor;
    body: string;
    display_name?: string;
  }) => Promise<void>;
}

/**
 * The new-comment composer as a popover pinned to the text it quotes.
 *
 * A draft is always composed over the document, never in a side pane,
 * and the margin column can only host it while it is actually on
 * screen. This is the surface for every other case: floating display
 * mode, a column the container query has hidden, a column the reader
 * collapsed. Both display modes mount it, which is why it owns its
 * placement rather than borrowing the floating layer's single popover
 * slot — column mode has no such slot.
 */
export function PendingCommentPopover({
  anchor,
  docHtml,
  docElementRef,
  scrollContainerRef,
  displayName,
  mentionCandidates,
  onCancel,
  onCreate,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

  /**
   * Prefer the painted highlight — its rect follows the quoted line
   * rather than the whole block. The draft's is the only comment mark
   * without a thread id. A quote the highlight pass could not place
   * falls back to the anchored block.
   */
  const resolveAnchorEl = useCallback((): HTMLElement | null => {
    const doc = docElementRef.current;
    if (!doc) return null;
    const mark = doc.querySelector<HTMLElement>(
      'mark[data-comment-highlight]:not([data-comment-thread-id])',
    );
    if (mark) return mark;
    if (anchor.block_id) return resolveAnchorElement(doc, anchor.block_id, anchor.quote);
    return null;
  }, [docElementRef, anchor]);

  const pos = useFloatingCardPlacement({
    cardEl,
    hostRef,
    scrollContainerRef,
    docElementRef,
    resolveAnchorEl,
    resetKey: anchor,
    repositionKeys: [docHtml],
  });

  async function submitNew(body: string, name?: string) {
    const payload: Parameters<typeof onCreate>[0] = { anchor, body };
    if (name !== undefined) payload.display_name = name;
    return onCreate(payload);
  }

  return (
    <div ref={hostRef} className="ic-float-host">
      <div
        ref={setCardEl}
        className="ic-float-card"
        role="dialog"
        aria-label="New comment"
        style={
          pos
            ? { top: `${pos.top}px`, left: `${pos.left}px` }
            : { top: 0, left: 0, visibility: 'hidden' }
        }
      >
        <button
          type="button"
          className="ic-float-close"
          onClick={onCancel}
          aria-label="Discard comment draft"
          title="Discard draft"
        >
          <Cross2Icon aria-hidden="true" />
        </button>
        <div className="ic-card ic-card-pending">
          <div className="ic-pending-quote">"{formatAnchorQuote(anchor.quote, 160)}"</div>
          <InlineComposer
            placeholder="Your comment…"
            needsName={!displayName}
            mentionCandidates={mentionCandidates}
            rows={3}
            submitLabel="Post"
            showCancel
            autoFocus
            onCancel={onCancel}
            onSubmit={submitNew}
          />
        </div>
      </div>
    </div>
  );
}
