import {
  CheckIcon,
  Cross2Icon,
  EyeClosedIcon,
  EyeOpenIcon,
  Link2Icon,
  Pencil2Icon,
  QuoteIcon,
  TrashIcon,
} from '@radix-ui/react-icons';
import { useEffect, useRef, useState } from 'react';
import type { Comment } from '../../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';
import { reportError } from '../../lib/log.js';
import { CollapsibleCommentBody } from './CollapsibleCommentBody.js';
import { EmojiReactionPicker } from './EmojiReactionPicker.js';
import { InlineAvatar } from './InlineAvatar.js';
import type { ThreadRefApi } from './threadRefs.js';

interface Props {
  node: Comment;
  variant?: 'opener' | 'reply';
  canQuote: boolean;
  /** Resolves thread ids mentioned in the body into links. */
  threadRefs: ThreadRefApi;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onSetHidden: (id: string, hidden: boolean) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onQuote?: ((text: string) => void) | undefined;
  /**
   * Toggle the viewer's reaction on this comment. When omitted, no
   * picker is shown and existing reactions render read-only — used by
   * static contexts (e.g. exports) that don't have a mutation surface.
   */
  onReact?: ((commentId: string, emoji: string) => Promise<void>) | undefined;
}

export function InlineCommentRow({
  node,
  variant = 'opener',
  canQuote,
  threadRefs,
  onEdit,
  onSetHidden,
  onDelete,
  onQuote,
  onReact,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const linkCopyTimer = useRef<number | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Clean up the copy-confirmation timer if the component unmounts while it's pending.
  useEffect(() => {
    return () => {
      if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (editing) editTextareaRef.current?.focus();
  }, [editing]);

  function startEdit() {
    setDraft(node.body);
    setEditing(true);
  }

  async function saveEdit() {
    const next = draft.trim();
    if (!next) return;
    setSaving(true);
    try {
      await onEdit(node.id, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setSaving(true);
    try {
      await onDelete(node.id);
    } finally {
      setSaving(false);
      setConfirmingDelete(false);
    }
  }

  async function copyLink() {
    try {
      const url = `${window.location.origin}${window.location.pathname}#comment-${node.id}`;
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      if (linkCopyTimer.current !== null) window.clearTimeout(linkCopyTimer.current);
      linkCopyTimer.current = window.setTimeout(() => setLinkCopied(false), 1500);
    } catch (err) {
      reportError('InlineCommentRow.copyLink', err);
    }
  }

  const showQuote = !editing && !confirmingDelete && canQuote && onQuote;
  const showEdit = !editing && !confirmingDelete && node.capabilities.edit;
  const showDelete = !editing && !confirmingDelete && node.capabilities.delete;
  const showHide = !editing && !confirmingDelete && node.capabilities.hide === true;
  const showReact = !editing && !confirmingDelete && node.capabilities.react && onReact;
  // Deleting the opener deletes the whole thread, replies included.
  const deleteLabel = variant === 'opener' ? 'Delete thread' : 'Delete';
  const confirmDeleteLabel = variant === 'opener' ? 'Confirm delete thread' : 'Confirm delete';

  async function toggleReaction(emoji: string) {
    if (!onReact || reacting) return;
    setReacting(true);
    try {
      await onReact(node.id, emoji);
    } catch (err) {
      reportError('InlineCommentRow.toggleReaction', err, { commentId: node.id, emoji });
    } finally {
      setReacting(false);
    }
  }

  async function toggleVisibility() {
    if (!showHide || visibilityBusy) return;
    setVisibilityBusy(true);
    try {
      await onSetHidden(node.id, !node.hidden);
    } finally {
      setVisibilityBusy(false);
    }
  }

  return (
    <div id={`comment-${node.id}`} className={`ic-row ic-row-${variant}`}>
      <InlineAvatar
        name={node.author.display_name}
        seed={node.author.client_id}
        size={variant === 'reply' ? 'sm' : 'md'}
      />
      <div className="ic-row-main">
        <div className="ic-row-meta">
          <span className="ic-row-author">{node.author.display_name}</span>
          <span className="ic-row-ts" title={formatTimestampLong(node.created_at)}>
            {formatTimestamp(node.created_at)}
          </span>
          {!editing && (
            <div className="ic-row-meta-actions-group">
              <div
                className="ic-row-meta-actions"
                data-confirming={confirmingDelete ? 'true' : undefined}
              >
                {confirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="ic-icon-btn"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={saving}
                      title="Cancel"
                      aria-label="Cancel"
                    >
                      <Cross2Icon />
                    </button>
                    <button
                      type="button"
                      className="ic-icon-btn ic-icon-btn-danger"
                      onClick={() => void confirmDelete()}
                      disabled={saving}
                      title={confirmDeleteLabel}
                      aria-label={confirmDeleteLabel}
                    >
                      <TrashIcon />
                    </button>
                  </>
                ) : (
                  <>
                    {showQuote && (
                      <button
                        type="button"
                        className="ic-icon-btn"
                        title="Quote"
                        aria-label="Quote"
                        onClick={() => onQuote?.(node.body)}
                      >
                        <QuoteIcon />
                      </button>
                    )}
                    <button
                      type="button"
                      className="ic-icon-btn"
                      title={linkCopied ? 'Link copied!' : 'Copy link to this comment'}
                      aria-label={linkCopied ? 'Link copied!' : 'Copy link to this comment'}
                      onClick={() => void copyLink()}
                    >
                      {linkCopied ? <CheckIcon /> : <Link2Icon />}
                    </button>
                    {showEdit && (
                      <button
                        type="button"
                        className="ic-icon-btn"
                        title="Edit"
                        aria-label="Edit"
                        onClick={startEdit}
                      >
                        <Pencil2Icon />
                      </button>
                    )}
                    {showDelete && (
                      <button
                        type="button"
                        className="ic-icon-btn ic-icon-btn-danger"
                        title={deleteLabel}
                        aria-label={deleteLabel}
                        onClick={() => setConfirmingDelete(true)}
                      >
                        <TrashIcon />
                      </button>
                    )}
                    {showReact && <EmojiReactionPicker onPick={toggleReaction} disabled={reacting} />}
                  </>
                )}
              </div>
              {showHide && (
                <button
                  type="button"
                  className={`ic-icon-btn ic-icon-btn-visibility${
                    node.hidden ? ' ic-icon-btn-visibility-active' : ''
                  }`}
                  disabled={visibilityBusy}
                  title={
                    node.hidden
                      ? 'Hidden — click to make this comment visible again'
                      : 'Hide comment — only you will be able to see it'
                  }
                  aria-label={node.hidden ? 'Unhide comment' : 'Hide comment'}
                  onClick={() => void toggleVisibility()}
                >
                  {node.hidden ? <EyeOpenIcon /> : <EyeClosedIcon />}
                </button>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <div className="ic-edit">
            <textarea
              ref={editTextareaRef}
              className="ic-composer-body"
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="ic-composer-actions">
              <button
                type="button"
                className="ic-btn ic-btn-ghost"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ic-btn ic-btn-primary"
                disabled={saving || !draft.trim()}
                onClick={() => void saveEdit()}
              >
                {saving ? '…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <CollapsibleCommentBody threadRefs={threadRefs}>{node.body}</CollapsibleCommentBody>
        )}

        {!editing && node.reactions.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: <fieldset> is form-only; reactions are not a form group
          <div className="ic-reactions" role="group" aria-label="Reactions">
            {node.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`ic-reaction-chip${r.reacted ? ' ic-reaction-chip-self' : ''}`}
                onClick={() => void toggleReaction(r.emoji)}
                disabled={reacting || !onReact || !node.capabilities.react}
                aria-pressed={r.reacted}
                aria-label={chipAriaLabel(r.emoji, r.count, r.reacted)}
                title={reactionTitle(r.authors)}
              >
                <span className="ic-reaction-chip-emoji">{r.emoji}</span>
                <span className="ic-reaction-chip-count" aria-hidden="true">
                  {r.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function reactionTitle(authors: string[]): string {
  const MAX = 8;
  const shown = authors.slice(0, MAX);
  const rest = authors.length - shown.length;
  const prefix = shown.join(', ');
  return rest > 0 ? `${prefix} and ${rest} more` : prefix;
}

/**
 * Accessible name for a reaction chip — without one, screen readers
 * announce the button as just its count (e.g. "2") because the emoji
 * span is decorative duplicate content. We voice the emoji + count and
 * note whether the viewer is among the reactors so toggling the chip
 * doesn't feel ambiguous.
 */
function chipAriaLabel(emoji: string, count: number, reacted: boolean): string {
  const base = `${emoji}, ${count} ${count === 1 ? 'reaction' : 'reactions'}`;
  return reacted ? `${base}, including yours` : base;
}
