import { useState } from 'react';
import type { Comment } from '../lib/api.js';
import { getClientId } from '../lib/identity.js';

interface Props {
  comment: Comment;
  isDocAdmin: boolean;
  onEdit: (id: string, body: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onReply?: (parentId: string) => void;
}

export function CommentItem({ comment, isDocAdmin, onEdit, onDelete, onReply }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const myId = getClientId();
  const isAuthor = comment.author.client_id === myId;

  return (
    <div className={`comment ${comment.parent_id ? 'reply' : 'top'}`}>
      <div className="comment-head">
        <span className="comment-author">{comment.author.display_name}</span>
        <span className="subtle comment-ts">{formatTs(comment.created_at)}</span>
        {comment.status !== 'active' && !comment.parent_id && (
          <span className={`chip status-${comment.status}`}>
            {comment.status === 'orphaned' ? 'orphaned' : 'may have moved'}
          </span>
        )}
      </div>
      {editing ? (
        <EditForm
          initial={draft}
          onCancel={() => {
            setEditing(false);
            setDraft(comment.body);
          }}
          onSave={async (v) => {
            await onEdit(comment.id, v);
            setDraft(v);
            setEditing(false);
          }}
        />
      ) : (
        <p className="comment-body">{comment.body}</p>
      )}
      {!editing && (
        <div className="comment-actions">
          {onReply && !comment.parent_id && (
            <button className="link" onClick={() => onReply(comment.id)}>
              Reply
            </button>
          )}
          {isAuthor && (
            <button className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {(isAuthor || isDocAdmin) && (
            <button className="link danger" onClick={() => onDelete(comment.id)}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EditForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (v: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="comment-edit">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        autoFocus
      />
      <div className="comment-actions">
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
          Save
        </button>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}
