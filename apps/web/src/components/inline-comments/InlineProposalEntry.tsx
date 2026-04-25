import type { BlockSourceRange } from '@marginalia/renderer';
import { useMemo, useState } from 'react';
import type { Thread, ThreadProposalData } from '../../lib/api.js';
import { getEditProposalDiff, proposalStatus } from '../../lib/api.js';
import { reportError } from '../../lib/log.js';
import { DiffDialog } from '../DiffDialog.js';
import { resolveProposalDiffBefore } from '../proposalDiff.js';
import { InlineAvatar } from './InlineAvatar.js';
import { inlineFormatTimestamp, inlineFormatTimestampLong } from './inlineUtils.js';

interface Props {
  uid: string;
  thread: Thread & { proposal: ThreadProposalData };
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
  onResolveThread: (
    threadId: string,
    kind: 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<void>;
  onEditRationale: (id: string, rationale: string | null) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
}

export function InlineProposalEntry({
  uid,
  thread,
  docSource,
  blockRanges,
  onResolveThread,
  onEditRationale,
  onDeleteThread,
}: Props) {
  const opener = thread.comments[0];
  const status = proposalStatus(thread);
  const isOpen = status === 'open';

  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [editingRationale, setEditingRationale] = useState(false);
  const [draft, setDraft] = useState(opener.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const originalSource = useMemo(
    () => resolveProposalDiffBefore({ thread, docSource, blockRanges }),
    [thread, docSource, blockRanges],
  );
  const diffBefore = resolvedDiff?.before ?? originalSource;
  const diffAfter = resolvedDiff?.after ?? thread.proposal.proposed_text;

  const canAccept = thread.capabilities.accept;
  const canReject = thread.capabilities.reject;
  const canDelete = opener.capabilities.delete && status !== 'accepted';
  const canEditRationale = opener.capabilities.edit && isOpen;

  async function showDiff() {
    if (loadingDiff) return;
    setDiffError(null);
    if (status === 'accepted' && !thread.proposal.source_snapshot) {
      if (resolvedDiff) {
        setDiffOpen(true);
        return;
      }
      setLoadingDiff(true);
      try {
        const diff = await getEditProposalDiff(uid, thread.id);
        setResolvedDiff(diff);
        setDiffOpen(true);
      } catch (err) {
        reportError('InlineProposalEntry.getEditProposalDiff', err, {
          uid,
          threadId: thread.id,
        });
        setDiffError('Could not load diff');
      } finally {
        setLoadingDiff(false);
      }
      return;
    }
    setResolvedDiff(null);
    setDiffOpen(true);
  }

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

  async function runResolve(kind: 'accept' | 'reject') {
    setBusy(true);
    try {
      await onResolveThread(thread.id, kind);
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

  return (
    <div className="ic-proposal-entry">
      <div className="ic-row ic-row-opener">
        <InlineAvatar name={opener.author.display_name} seed={opener.author.client_id} />
        <div className="ic-row-main">
          <div className="ic-row-meta">
            <span className="ic-row-author">{opener.author.display_name}</span>
            <span className="ic-row-ts" title={inlineFormatTimestampLong(opener.created_at)}>
              {inlineFormatTimestamp(opener.created_at)}
            </span>
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
              {hasRationale ? opener.body : 'Change proposal'}
            </div>
          )}

          <div className="ic-row-actions">
            {!confirmingDelete && (
              <button
                type="button"
                className="ic-btn ic-btn-link"
                onClick={() => void showDiff()}
                disabled={loadingDiff}
              >
                {loadingDiff ? 'Loading…' : 'Show diff'}
              </button>
            )}
            {diffError && <span className="ic-error">{diffError}</span>}
            {!confirmingDelete && canEditRationale && !editingRationale && (
              <button
                type="button"
                className="ic-btn ic-btn-link"
                onClick={() => {
                  setDraft(opener.body);
                  setEditingRationale(true);
                }}
              >
                Edit reason
              </button>
            )}
            {canDelete && !confirmingDelete && (
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
            )}
          </div>

          {isOpen && (canAccept || canReject) && (
            <div className="ic-row-actions ic-workflow-actions">
              {canAccept && (
                <button
                  type="button"
                  className="ic-btn ic-btn-accept"
                  onClick={() => void runResolve('accept')}
                  disabled={busy}
                >
                  Accept
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  className="ic-btn ic-btn-reject"
                  onClick={() => void runResolve('reject')}
                  disabled={busy}
                >
                  Reject
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="Proposed change"
        before={diffBefore}
        after={diffAfter}
        actions={
          isOpen && (canAccept || canReject) ? (
            <>
              {canAccept && (
                <button
                  type="button"
                  className="ic-btn ic-btn-accept"
                  onClick={async () => {
                    await runResolve('accept');
                    setDiffOpen(false);
                  }}
                >
                  Accept
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  className="ic-btn ic-btn-reject"
                  onClick={async () => {
                    await runResolve('reject');
                    setDiffOpen(false);
                  }}
                >
                  Reject
                </button>
              )}
            </>
          ) : null
        }
      />
    </div>
  );
}
