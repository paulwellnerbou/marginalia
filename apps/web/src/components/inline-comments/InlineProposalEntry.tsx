import { Pencil2Icon, TrashIcon } from '@radix-ui/react-icons';
import { useState } from 'react';
import type { Thread, ThreadProposalData } from '../../lib/api.js';
import { proposalStatus } from '../../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../../lib/format-time.js';
import { InlineAvatar } from './InlineAvatar.js';
import { InlineCommentMarkdown } from './InlineCommentMarkdown.js';

interface Props {
  thread: Thread & { proposal: ThreadProposalData };
  onEditRationale: (id: string, rationale: string | null) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
}

export function InlineProposalEntry({ thread, onEditRationale, onDeleteThread }: Props) {
  const opener = thread.comments[0];
  const status = proposalStatus(thread);
  const isOpen = status === 'open';

  const [editingRationale, setEditingRationale] = useState(false);
  const [draft, setDraft] = useState(opener.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const canDelete = opener.capabilities.delete && status !== 'accepted';
  const canEditRationale = opener.capabilities.edit && isOpen;

  async function saveRationale() {
    setBusy(true);
    try {
      const next = draft.trim();
      await onEditRationale(thread.id, next.length > 0 ? next : null);
      setEditingRationale(false);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      await onDeleteThread(thread.id);
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  const hasRationale = opener.body.trim().length > 0;
  const showEditIcon = !editingRationale && !confirmingDelete && canEditRationale;
  const showDeleteIcon = !editingRationale && !confirmingDelete && canDelete;

  return (
    <div className="ic-row ic-row-opener">
      <InlineAvatar name={opener.author.display_name} seed={opener.author.client_id} />
      <div className="ic-row-main">
        <div className="ic-row-meta">
          <span className="ic-row-author">{opener.author.display_name}</span>
          <span className="ic-row-ts" title={formatTimestampLong(opener.created_at)}>
            {formatTimestamp(opener.created_at)}
          </span>
          {!editingRationale && (
            <div className="ic-row-meta-actions">
              {confirmingDelete ? (
                <>
                  <span className="ic-confirm-prompt">Delete proposal?</span>
                  <button
                    type="button"
                    className="ic-btn ic-btn-link"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ic-btn ic-btn-link ic-btn-danger"
                    onClick={() => void confirmDelete()}
                    disabled={busy}
                  >
                    Yes, delete
                  </button>
                </>
              ) : (
                <>
                  {showEditIcon && (
                    <button
                      type="button"
                      className="ic-icon-btn"
                      title="Edit reason"
                      aria-label="Edit reason"
                      onClick={() => {
                        setDraft(opener.body);
                        setEditingRationale(true);
                      }}
                    >
                      <Pencil2Icon />
                    </button>
                  )}
                  {showDeleteIcon && (
                    <button
                      type="button"
                      className="ic-icon-btn ic-icon-btn-danger"
                      title="Delete proposal"
                      aria-label="Delete proposal"
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

        {editingRationale ? (
          <div className="ic-edit">
            <textarea
              className="ic-composer-body"
              value={draft}
              rows={3}
              placeholder="Reason for this change (optional)"
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="ic-composer-actions">
              <button
                type="button"
                className="ic-btn ic-btn-ghost"
                onClick={() => setEditingRationale(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ic-btn ic-btn-primary"
                onClick={() => void saveRationale()}
                disabled={busy}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className={`ic-row-body ic-proposal-rationale${hasRationale ? '' : ' ic-empty'}`}>
            {hasRationale ? (
              <InlineCommentMarkdown>{opener.body}</InlineCommentMarkdown>
            ) : (
              'Change proposal'
            )}
          </div>
        )}
      </div>
    </div>
  );
}
