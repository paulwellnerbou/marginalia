import {
  BookmarkFilledIcon,
  BookmarkIcon,
  Cross2Icon,
  Pencil1Icon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { Tooltip } from '@radix-ui/themes';
import { Eye, EyeOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Thread } from '../../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';

/** A label names a place; anything longer is a comment. */
const BOOKMARK_LABEL_MAX_LENGTH = 200;

interface Props {
  thread: Thread;
  /** Made by the viewer, rather than shared with them by someone else. */
  own: boolean;
  focused: boolean;
  flashPhase: 'a' | 'b' | null;
  onJump?: (() => void) | undefined;
  onRemove: (threadId: string) => Promise<void>;
  /** Resolves `false` when the save failed, so the field keeps the draft. */
  onEditLabel: (commentId: string, label: string) => Promise<boolean | void>;
  onSetHidden: (commentId: string, hidden: boolean) => Promise<void>;
  /** Set while the card is listed only because the reader opened it. */
  onDismissRevealed?: (() => void) | undefined;
}

/**
 * A bookmark in the Bookmarks tab. It has no replies, so none of a thread
 * card's machinery applies — only the passage it marks, the optional label,
 * when it was made, whether it is shared, and a way to drop it. Someone
 * else's shared bookmark also names who made it. It keeps the thread card's
 * `data-comment-thread-id` and focus/flash classes, which is what the
 * list's focus handling scrolls to and lights up.
 */
export function BookmarkCard({
  thread,
  own,
  focused,
  flashPhase,
  onJump,
  onRemove,
  onEditLabel,
  onSetHidden,
  onDismissRevealed,
}: Props) {
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [sharing, setSharing] = useState(false);
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

  const shared = root.hidden !== true;

  async function toggleShared() {
    setSharing(true);
    try {
      await onSetHidden(root.id, shared);
    } finally {
      setSharing(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await onRemove(thread.id);
    } finally {
      setRemoving(false);
      setConfirmingRemove(false);
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

  const removeLabel = own ? 'Remove bookmark' : 'Remove this bookmark for everyone';
  const confirmRemoveLabel = own
    ? 'Confirm remove bookmark'
    : 'Confirm remove this bookmark for everyone';
  const primaryClass = label ? 'ic-bookmark-card-label' : 'ic-card-anchor ic-bookmark-card-quote';
  const primaryText = label || quoteText;

  return (
    <article className={classes} data-comment-thread-id={thread.id} tabIndex={-1}>
      {own ? (
        <BookmarkFilledIcon className="ic-bookmark-card-icon" aria-hidden />
      ) : (
        <BookmarkIcon className="ic-bookmark-card-icon" aria-hidden />
      )}
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
        <span className="ic-bookmark-card-meta">
          {!own && <span className="ic-bookmark-card-author">{root.author.display_name}</span>}
          <span className="ic-row-ts" title={formatTimestampLong(root.created_at)}>
            {formatTimestamp(root.created_at)}
          </span>
          {own && shared && <span className="ic-bookmark-card-shared">Shared</span>}
          {onDismissRevealed && (
            <Tooltip content="Outside the current filter or search — listed because you opened it. Click to hide it again.">
              <button
                type="button"
                className="ic-badge ic-badge-revealed"
                onClick={onDismissRevealed}
                aria-label="Outside filters — hide this bookmark again"
              >
                Outside filters
                <Cross2Icon className="ic-badge-icon" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
      {draft === null &&
        (confirmingRemove ? (
          <>
            <Tooltip content="Cancel">
              <button
                type="button"
                className="ic-icon-btn"
                onClick={() => setConfirmingRemove(false)}
                disabled={removing}
                aria-label="Cancel"
              >
                <Cross2Icon />
              </button>
            </Tooltip>
            <Tooltip content={confirmRemoveLabel}>
              <button
                type="button"
                className="ic-icon-btn ic-icon-btn-danger"
                onClick={() => void remove()}
                disabled={removing}
                aria-label={confirmRemoveLabel}
              >
                <TrashIcon />
              </button>
            </Tooltip>
          </>
        ) : (
          <>
            {root.capabilities.hide === true && (
              <Tooltip
                content={
                  shared
                    ? 'Everyone with access can see this bookmark. Click to keep it to yourself'
                    : 'Only you can see this bookmark. Click to share it'
                }
              >
                <button
                  type="button"
                  className={`ic-icon-btn ic-icon-btn-visibility${
                    shared ? '' : ' ic-icon-btn-visibility-active'
                  }`}
                  disabled={sharing}
                  aria-pressed={shared}
                  aria-label={shared ? 'Make bookmark private' : 'Share bookmark'}
                  onClick={() => void toggleShared()}
                >
                  {shared ? <Eye strokeWidth={2.25} /> : <EyeOff strokeWidth={2.25} />}
                </button>
              </Tooltip>
            )}
            {root.capabilities.edit && (
              <Tooltip content={label ? 'Edit label' : 'Add a label'}>
                <button
                  type="button"
                  className="ic-icon-btn"
                  onClick={startEditing}
                  aria-label={label ? 'Edit label' : 'Add a label'}
                >
                  <Pencil1Icon />
                </button>
              </Tooltip>
            )}
            {root.capabilities.delete && (
              <Tooltip content={removeLabel}>
                <button
                  type="button"
                  className="ic-icon-btn ic-icon-btn-danger"
                  onClick={() => setConfirmingRemove(true)}
                  aria-label={removeLabel}
                >
                  <TrashIcon />
                </button>
              </Tooltip>
            )}
          </>
        ))}
    </article>
  );
}
