import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Comment } from '../../lib/api.js';
import { InlineAvatar } from './InlineAvatar.js';
import { inlineFormatTimestamp, inlineFormatTimestampLong } from './inlineUtils.js';

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

  return (
    <div className={`ic-row ic-row-${variant}`}>
      <InlineAvatar
        name={node.author.display_name}
        seed={node.author.client_id}
        size={variant === 'reply' ? 'sm' : 'md'}
      />
      <div className="ic-row-main">
        <div className="ic-row-meta">
          <span className="ic-row-author">{node.author.display_name}</span>
          <span className="ic-row-ts" title={inlineFormatTimestampLong(node.created_at)}>
            {inlineFormatTimestamp(node.created_at)}
          </span>
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

        {!editing && (
          <div className="ic-row-actions">
            {canQuote && onQuote && !confirmingDelete && (
              <button
                type="button"
                className="ic-btn ic-btn-link"
                onClick={() => onQuote(node.body)}
              >
                Quote
              </button>
            )}
            {!confirmingDelete && node.capabilities.edit && (
              <button type="button" className="ic-btn ic-btn-link" onClick={startEdit}>
                Edit
              </button>
            )}
            {node.capabilities.delete && !confirmingDelete && (
              <button
                type="button"
                className="ic-btn ic-btn-link ic-btn-danger"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
            {confirmingDelete && (
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
