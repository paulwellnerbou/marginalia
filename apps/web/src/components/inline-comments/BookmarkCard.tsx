import { BookmarkFilledIcon, Cross2Icon, Pencil1Icon } from '@radix-ui/react-icons';
import { useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Thread } from '../../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';

/** A label names a place; anything longer is a comment. */
const BOOKMARK_LABEL_MAX_LENGTH = 200;

interface Props {
  thread: Thread;
  focused: boolean;
  flashPhase: 'a' | 'b' | null;
  onJump?: (() => void) | undefined;
  onRemove: (threadId: string) => Promise<void>;
  /** Resolves `false` when the save failed, so the field keeps the draft. */
  onEditLabel: (commentId: string, label: string) => Promise<boolean | void>;
}

/**
 * A bookmark in the Bookmarks tab. It has no author line or replies, so
 * none of a thread card's machinery applies — only the passage it marks,
 * the reader's optional label, when it was made, and a way to drop it. It
 * keeps the thread card's `data-comment-thread-id` and focus/flash
 * classes, which is what the list's focus handling scrolls to and lights up.
 */
export function BookmarkCard({
  thread,
  focused,
  flashPhase,
  onJump,
  onRemove,
  onEditLabel,
}: Props) {
  const [removing, setRemoving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Blur also saves, and disabling the field mid-save or unmounting it
  // after Escape blurs it, with a closure still holding the old draft.
  const editing = useRef(false);
  const root = thread.comments[0];
  const label = root.body.trim();
  const quote = formatAnchorQuote(thread.anchor.quote, 120);
  const quoteText = quote ? `"${quote}"` : 'Bookmarked passage';
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

  function startEditing() {
    editing.current = true;
    setDraft(label);
  }

  function stopEditing() {
    editing.current = false;
    setDraft(null);
  }

  async function save() {
    if (draft === null || !editing.current) return;
    const next = draft.trim();
    if (next === label) {
      stopEditing();
      return;
    }
    editing.current = false;
    setSaving(true);
    try {
      if ((await onEditLabel(root.id, next)) !== false) setDraft(null);
      else editing.current = true;
    } finally {
      setSaving(false);
    }
  }

  const primaryClass = label ? 'ic-bookmark-card-label' : 'ic-card-anchor ic-bookmark-card-quote';
  const primaryText = label || quoteText;

  return (
    <article className={classes} data-comment-thread-id={thread.id} tabIndex={-1}>
      <BookmarkFilledIcon className="ic-bookmark-card-icon" aria-hidden />
      <div className="ic-bookmark-card-main">
        {draft !== null ? (
          <input
            type="text"
            className="ic-composer-name ic-bookmark-card-label-input"
            placeholder="Label this bookmark"
            aria-label="Bookmark label"
            value={draft}
            maxLength={BOOKMARK_LABEL_MAX_LENGTH}
            disabled={saving}
            // biome-ignore lint/a11y/noAutofocus: opened by the reader's own click on Edit label
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                stopEditing();
              }
            }}
          />
        ) : onJump ? (
          <button
            type="button"
            className={primaryClass}
            title="Jump to this place in the document"
            onClick={onJump}
          >
            {primaryText}
          </button>
        ) : (
          <span className={`${primaryClass} ic-bookmark-card-static`}>{primaryText}</span>
        )}
        {label && (
          <span className="ic-card-anchor ic-bookmark-card-quote ic-bookmark-card-static">
            {quoteText}
          </span>
        )}
        <span className="ic-row-ts" title={formatTimestampLong(root.created_at)}>
          {formatTimestamp(root.created_at)}
        </span>
      </div>
      {root.capabilities.edit && draft === null && (
        <button
          type="button"
          className="ic-icon-btn"
          onClick={startEditing}
          title={label ? 'Edit label' : 'Add a label'}
          aria-label={label ? 'Edit label' : 'Add a label'}
        >
          <Pencil1Icon />
        </button>
      )}
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
