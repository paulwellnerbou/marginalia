import { BookmarkFilledIcon, Cross2Icon } from '@radix-ui/react-icons';
import { useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Thread } from '../../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';

interface Props {
  thread: Thread;
  focused: boolean;
  flashPhase: 'a' | 'b' | null;
  onJump?: (() => void) | undefined;
  onRemove: (threadId: string) => Promise<void>;
}

/**
 * A bookmark in the Bookmarks tab. It has no text, author line or replies,
 * so none of a thread card's machinery applies — only the passage it marks,
 * when it was made, and a way to drop it. It keeps the thread card's
 * `data-comment-thread-id` and focus/flash classes, which is what the list's
 * focus handling scrolls to and lights up.
 */
export function BookmarkCard({ thread, focused, flashPhase, onJump, onRemove }: Props) {
  const [removing, setRemoving] = useState(false);
  const quote = formatAnchorQuote(thread.anchor.quote, 120);
  const label = quote ? `"${quote}"` : 'Bookmarked passage';
  const createdAt = thread.comments[0].created_at;
  const classes = [
    'ic-card',
    'ic-card-bookmark-only',
    focused ? 'ic-card-focused' : '',
    flashPhase ? `ic-card-flash-${flashPhase}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  async function remove() {
    setRemoving(true);
    try {
      await onRemove(thread.id);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <article className={classes} data-comment-thread-id={thread.id} tabIndex={-1}>
      <BookmarkFilledIcon className="ic-bookmark-card-icon" aria-hidden />
      <div className="ic-bookmark-card-main">
        {onJump ? (
          <button
            type="button"
            className="ic-card-anchor ic-bookmark-card-quote"
            title="Jump to this place in the document"
            onClick={onJump}
          >
            {label}
          </button>
        ) : (
          <span className="ic-card-anchor ic-bookmark-card-quote">{label}</span>
        )}
        <span className="ic-row-ts" title={formatTimestampLong(createdAt)}>
          {formatTimestamp(createdAt)}
        </span>
      </div>
      <button
        type="button"
        className="ic-icon-btn ic-icon-btn-danger"
        onClick={() => void remove()}
        disabled={removing}
        title="Remove bookmark"
        aria-label="Remove bookmark"
      >
        <Cross2Icon />
      </button>
    </article>
  );
}
