import { FileTextIcon, PilcrowIcon } from '@radix-ui/react-icons';
import { useMemo, useRef, useState } from 'react';
import type { Comment, ProposalDiff, Thread } from '../../lib/api.js';
import { getEditProposalDiff, isProposal, proposalStatus } from '../../lib/api.js';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import { reportError } from '../../lib/log.js';
import { DiffDialog } from '../DiffDialog.js';
import { InlineCommentRow } from './InlineCommentRow.js';
import { InlineComposer, type InlineComposerHandle } from './InlineComposer.js';

interface Props {
  uid: string;
  thread: Thread;
  canComment: boolean;
  needsName: boolean;
  focused: boolean;
  flashPhase: 'a' | 'b' | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onJump?: (() => void) | undefined;
  onReply: (threadId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<boolean>;
}

export function InlineThreadCard({
  uid,
  thread,
  canComment,
  needsName,
  focused,
  flashPhase,
  collapsed,
  onToggleCollapsed,
  onJump,
  onReply,
  onEdit,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
}: Props) {
  const composerRef = useRef<InlineComposerHandle>(null);
  const [busy, setBusy] = useState<'accept' | 'reject' | 'resolve' | 'reopen' | false>(false);

  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<ProposalDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const proposal = isProposal(thread);
  const status = proposal ? proposalStatus(thread) : null;
  const isResolved = thread.state === 'resolved';
  const isOrphan = thread.link_status === 'orphaned' && status !== 'accepted';
  const replies = thread.comments.slice(1);

  const proposalThread = proposal
    ? (thread as Thread & { proposal: NonNullable<Thread['proposal']> })
    : null;

  const canAccept = proposal && thread.capabilities.accept;
  const canReject = proposal && thread.capabilities.reject;
  const canResolve = !proposal && !isResolved && thread.capabilities.resolve;
  const canReopen = !proposal && isResolved && thread.capabilities.reopen;

  // Once a proposal leaves the open state, its rationale is part of the
  // accept-commit message in git — freeze edits, and freeze deletes once
  // accepted so the recorded history can't be erased from this UI.
  const openerNode: Comment = useMemo(() => {
    if (!proposal) return thread.comments[0];
    const base = thread.comments[0];
    return {
      ...base,
      capabilities: {
        edit: base.capabilities.edit && status === 'open',
        delete: base.capabilities.delete && status !== 'accepted',
      },
    };
  }, [thread.comments, proposal, status]);

  function handleQuote(text: string) {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    composerRef.current?.insertText(quoted);
    composerRef.current?.focus();
  }

  async function showDiff() {
    if (!proposalThread || loadingDiff) return;
    setDiffError(null);
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
      reportError('InlineThreadCard.getEditProposalDiff', err, {
        uid,
        threadId: thread.id,
      });
      setDiffError('Could not load diff');
    } finally {
      setLoadingDiff(false);
    }
  }

  async function runWorkflow(
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ): Promise<boolean> {
    // Returning false on the re-entry guard (rather than the in-flight
    // promise) prevents a second click on a still-busy button from
    // resolving immediately and tricking callers into post-success steps
    // (e.g. closing the diff dialog before the original request finishes).
    if (busy) return false;
    setBusy(kind);
    try {
      return await onResolveThread(thread.id, kind, body, name);
    } finally {
      setBusy(false);
    }
  }

  // Render label + overlaid spinner so the button keeps its label-width
  // while in flight (no horizontal jump of neighbors). The label is also
  // visually hidden via CSS, but the button's `aria-label` keeps a stable
  // accessible name across states.
  function workflowContent(label: string, isBusy: boolean) {
    return (
      <>
        <span className={isBusy ? 'ic-btn-label-hidden' : undefined}>{label}</span>
        {isBusy && (
          <span className="ic-btn-spinner-overlay" aria-hidden="true">
            <span className="ic-spinner" />
          </span>
        )}
      </>
    );
  }

  const cardClasses = [
    'ic-card',
    focused ? 'ic-card-focused' : '',
    flashPhase ? `ic-card-flash-${flashPhase}` : '',
    isResolved ? 'ic-card-resolved' : '',
    proposal ? 'ic-card-proposal' : 'ic-card-comment',
    proposal && status ? `ic-card-proposal-${status}` : '',
    isOrphan ? 'ic-card-orphaned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const summary = proposal
    ? statusLabel(thread, status)
    : `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`;
  const anchorQuote = formatAnchorQuote(thread.anchor.quote, 80);

  return (
    <article className={cardClasses} data-comment-thread-id={thread.id} tabIndex={-1}>
      <header className="ic-card-header">
        <div className="ic-card-header-top">
          <div className="ic-card-badges">
            {proposalThread && (
              <span
                className="ic-badge ic-badge-proposal"
                title={
                  proposalThread.proposal.whole_document
                    ? 'Whole-document proposal'
                    : 'Block proposal'
                }
              >
                {proposalThread.proposal.whole_document ? (
                  <FileTextIcon className="ic-badge-icon" aria-hidden="true" />
                ) : (
                  <PilcrowIcon className="ic-badge-icon" aria-hidden="true" />
                )}
                Proposed change
              </span>
            )}
            {proposal && status === 'accepted' && (
              <span className="ic-badge ic-badge-accepted">Accepted</span>
            )}
            {proposal && status === 'rejected' && (
              <span className="ic-badge ic-badge-rejected">Rejected</span>
            )}
            {isResolved && !proposal && (
              <span className="ic-badge ic-badge-resolved">Resolved</span>
            )}
            {isOrphan && <span className="ic-badge ic-badge-orphan">Orphaned</span>}
          </div>
          {proposal && (
            <button
              type="button"
              className="ic-btn ic-btn-link ic-card-show-diff"
              onClick={() => void showDiff()}
              disabled={loadingDiff}
              title="Show the proposed text change"
            >
              {loadingDiff ? 'Loading…' : 'Show diff'}
            </button>
          )}
        </div>
        {diffError && <span className="ic-error">{diffError}</span>}
        {onJump && (
          <button
            type="button"
            className="ic-card-anchor"
            title="Jump to this location in the document"
            onClick={onJump}
          >
            <span aria-hidden>↗</span>{' '}
            {anchorQuote
              ? `"${anchorQuote}"`
              : 'Jump to anchor'}
          </button>
        )}
        <button
          type="button"
          className="ic-btn ic-btn-link ic-card-collapse"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? `Expand · ${summary}` : 'Collapse'}
        </button>
      </header>

      {!collapsed && (
        <div className="ic-card-body">
          <InlineCommentRow
            node={openerNode}
            variant="opener"
            canQuote={canComment}
            onEdit={onEdit}
            onDelete={() => onDeleteThread(thread.id)}
            onQuote={canComment ? handleQuote : undefined}
          />

          {replies.map((reply) => (
            <InlineCommentRow
              key={reply.id}
              node={reply}
              variant="reply"
              canQuote={canComment}
              onEdit={onEdit}
              onDelete={onDeleteNode}
              onQuote={canComment ? handleQuote : undefined}
            />
          ))}

          {canComment ? (
            <InlineComposer
              ref={composerRef}
              placeholder="Reply…"
              needsName={needsName}
              rows={2}
              submitLabel="Reply"
              onSubmit={(body, name) => onReply(thread.id, body, name)}
              leftActions={
                canAccept || canReject || canResolve || canReopen
                  ? ({ canRunAction, runAction }) => {
                      // Keep the in-flight button enabled so screen readers
                      // announce its `aria-busy` state (disabled buttons drop
                      // out of the focus order and the announcement is lost).
                      // Sibling buttons stay disabled to prevent racing actions.
                      // `canRunAction` is false while submitting OR while the
                      // composer still needs a display name — gate inactive
                      // buttons in both cases.
                      const isDisabledFor = (kind: typeof busy) =>
                        busy === false ? !canRunAction : busy !== kind;
                      return (
                        <>
                          {canAccept && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-accept"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('accept', body, name))
                              }
                              disabled={isDisabledFor('accept')}
                              aria-busy={busy === 'accept'}
                              aria-label="Accept"
                            >
                              {workflowContent('Accept', busy === 'accept')}
                            </button>
                          )}
                          {canReject && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-reject"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('reject', body, name))
                              }
                              disabled={isDisabledFor('reject')}
                              aria-busy={busy === 'reject'}
                              aria-label="Reject"
                            >
                              {workflowContent('Reject', busy === 'reject')}
                            </button>
                          )}
                          {canResolve && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-resolve"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('resolve', body, name))
                              }
                              disabled={isDisabledFor('resolve')}
                              aria-busy={busy === 'resolve'}
                              aria-label="Resolve"
                            >
                              {workflowContent('Resolve', busy === 'resolve')}
                            </button>
                          )}
                          {canReopen && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-ghost"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('reopen', body, name))
                              }
                              disabled={isDisabledFor('reopen')}
                              aria-busy={busy === 'reopen'}
                              aria-label="Reopen"
                            >
                              {workflowContent('Reopen', busy === 'reopen')}
                            </button>
                          )}
                        </>
                      );
                    }
                  : undefined
              }
            />
          ) : (
            (canAccept || canReject || canResolve || canReopen) && (
              <div className="ic-card-workflow ic-card-workflow-standalone">
                {canAccept && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-accept"
                    onClick={() => void runWorkflow('accept')}
                    disabled={busy !== false && busy !== 'accept'}
                    aria-busy={busy === 'accept'}
                    aria-label="Accept"
                  >
                    {workflowContent('Accept', busy === 'accept')}
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-reject"
                    onClick={() => void runWorkflow('reject')}
                    disabled={busy !== false && busy !== 'reject'}
                    aria-busy={busy === 'reject'}
                    aria-label="Reject"
                  >
                    {workflowContent('Reject', busy === 'reject')}
                  </button>
                )}
                {canResolve && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-resolve"
                    onClick={() => void runWorkflow('resolve')}
                    disabled={busy !== false && busy !== 'resolve'}
                    aria-busy={busy === 'resolve'}
                    aria-label="Resolve"
                  >
                    {workflowContent('Resolve', busy === 'resolve')}
                  </button>
                )}
                {canReopen && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost"
                    onClick={() => void runWorkflow('reopen')}
                    disabled={busy !== false && busy !== 'reopen'}
                    aria-busy={busy === 'reopen'}
                    aria-label="Reopen"
                  >
                    {workflowContent('Reopen', busy === 'reopen')}
                  </button>
                )}
              </div>
            )
          )}
        </div>
      )}

      {proposalThread && (
        <DiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          title="Proposed change"
          before={resolvedDiff?.before ?? ''}
          after={resolvedDiff?.after ?? ''}
          actions={
            status === 'open' && (canAccept || canReject) ? (
              <>
                {canAccept && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-accept"
                    onClick={async () => {
                      // Only close when the action actually succeeded.
                      // A re-entry click while busy returns false too, so
                      // the dialog stays open until the original finishes.
                      if (await runWorkflow('accept')) setDiffOpen(false);
                    }}
                    disabled={busy !== false && busy !== 'accept'}
                    aria-busy={busy === 'accept'}
                    aria-label="Accept"
                  >
                    {workflowContent('Accept', busy === 'accept')}
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-reject"
                    onClick={async () => {
                      if (await runWorkflow('reject')) setDiffOpen(false);
                    }}
                    disabled={busy !== false && busy !== 'reject'}
                    aria-busy={busy === 'reject'}
                    aria-label="Reject"
                  >
                    {workflowContent('Reject', busy === 'reject')}
                  </button>
                )}
              </>
            ) : null
          }
        />
      )}
    </article>
  );
}

function statusLabel(thread: Thread, status: ReturnType<typeof proposalStatus> | null): string {
  if (status === 'accepted') {
    return `Accepted${thread.resolution?.by_name ? ` by ${thread.resolution.by_name}` : ''}`;
  }
  if (status === 'rejected') {
    return `Rejected${thread.resolution?.by_name ? ` by ${thread.resolution.by_name}` : ''}`;
  }
  const total = thread.comments.length;
  return `${total} message${total === 1 ? '' : 's'}`;
}
