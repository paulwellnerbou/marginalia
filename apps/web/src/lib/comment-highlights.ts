/**
 * Which comment anchors the rendered document paints, and how.
 *
 * Kept apart from the layout component because this is the one place
 * that decides whether a thread leaves a trace in the text at all —
 * every mark it emits is both a visual marker and a click target.
 */

import {
  type CommentAnchor,
  isProposal,
  isResolved,
  type Thread,
  type ThreadState,
} from './api.js';
import { highlightRange } from './block-span.js';

export interface CommentHighlight {
  scope: 'range' | 'block';
  threadId?: string;
  blockId: string;
  endBlockId?: string | null;
  quote: string;
  startOffset: number;
  endOffset: number;
  state?: ThreadState;
}

export interface CommentHighlightOptions {
  /** Leave resolved threads out of the text entirely — see below. */
  hideResolved: boolean;
  /** Anchor of a comment being composed, painted before it exists. */
  pendingAnchor?: CommentAnchor | null;
}

/**
 * A resolved thread's highlight is invisible (see
 * `mark.comment-highlight-resolved`) and never a click target — the
 * renderer withholds the id its click handler reads from anything but an
 * open thread, so settled threads are opened from the Threads tab and
 * Activities, which list them on purpose. Dropping them here as well,
 * rather than styling them away, keeps the marks out of the DOM
 * entirely, which is what a long-lived document with hundreds of settled
 * threads actually needs.
 */
export function buildCommentHighlights(
  threads: readonly Thread[],
  { hideResolved, pendingAnchor = null }: CommentHighlightOptions,
): CommentHighlight[] {
  const highlights: CommentHighlight[] = [];

  for (const thread of threads) {
    if (hideResolved && isResolved(thread)) continue;
    // Orphaned threads have no anchor at all; skip them. Linked and
    // low-confidence threads both still carry a block_id + quote and
    // can drive a highlight — the renderer's `findHighlightBlock`
    // narrowing pass recovers the right element regardless of which
    // confidence band the server assigned.
    if (thread.link_status === 'orphaned') continue;
    if (!thread.anchor.block_id || !thread.anchor.quote) continue;

    if (!isProposal(thread)) {
      const range = highlightRange(thread.anchor);
      if (range) {
        highlights.push({
          scope: 'range',
          threadId: thread.id,
          blockId: thread.anchor.block_id,
          endBlockId: thread.anchor.end_block_id ?? null,
          quote: thread.anchor.quote,
          ...range,
          state: thread.state,
        });
      }
    } else if (thread.state === 'open') {
      // Block-scope highlights paint a background across the *whole*
      // anchored block, which a settled proposal has no business doing,
      // so only emit them while the proposal is open. Activities-tab
      // navigation falls back to [data-block]/[data-subblock] via
      // blockId, so scroll-to-anchor still works for resolved ones.
      highlights.push({
        scope: 'block',
        threadId: thread.id,
        blockId: thread.anchor.block_id,
        endBlockId: thread.anchor.end_block_id ?? null,
        quote: thread.anchor.quote,
        startOffset: 0,
        endOffset: thread.anchor.quote.length,
        state: thread.state,
      });
    }
  }

  const pendingRange = pendingAnchor ? highlightRange(pendingAnchor) : null;
  if (pendingAnchor && pendingRange) {
    highlights.push({
      scope: 'range',
      blockId: pendingAnchor.block_id,
      endBlockId: pendingAnchor.end_block_id ?? null,
      quote: pendingAnchor.quote,
      ...pendingRange,
    });
  }

  return highlights;
}
