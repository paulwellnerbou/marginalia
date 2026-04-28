import { CheckIcon, Link2Icon, Pencil2Icon, QuoteIcon, TrashIcon } from '@radix-ui/react-icons';
import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Comment } from '../../lib/api.js';
import { reportError } from '../../lib/log.js';
import { InlineAvatar } from './InlineAvatar.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';

interface Props {
  node: Comment;
  variant?: 'opener' | 'reply';
  canQuote: boolean;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onQuote?: ((text: string) => void) | undefined;
}

export function InlineCommentRow({
  node,
  variant = 'opener',
  canQuote,
  onEdit,
  onDelete,
  onQuote,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const linkCopyTimer = useRef<number | null>(null);

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
            <div className="ic-row-meta-actions">
              {confirmingDelete ? (
                <>
                  <span className="ic-confirm-prompt">Delete?</span>
                  <button
                    type="button"
                    className="ic-btn ic-btn-link"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ic-btn ic-btn-link ic-btn-danger"
                    onClick={() => void confirmDelete()}
                    disabled={saving}
                  >
                    Yes, delete
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
                      title="Delete"
                      aria-label="Delete"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <div className="ic-edit">
            <textarea
              className="ic-composer-body"
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
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
          <div className="ic-row-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.body}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
