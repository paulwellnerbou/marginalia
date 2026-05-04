import type { BlockSourceRange } from '@marginalia/renderer';
import { FileTextIcon, PilcrowIcon } from '@radix-ui/react-icons';
import { useMemo, useRef, useState } from 'react';
import type { Thread } from '../../lib/api.js';
import { getEditProposalDiff, isProposal, proposalStatus } from '../../lib/api.js';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import { reportError } from '../../lib/log.js';
import { DiffDialog } from '../DiffDialog.js';
import type { DocumentFormat } from '../../lib/api.js';
import { resolveProposalDiffBefore } from '../proposalDiff.js';
import { InlineCommentRow } from './InlineCommentRow.js';
import { InlineComposer, type InlineComposerHandle } from './InlineComposer.js';
import { InlineProposalEntry } from './InlineProposalEntry.js';

interface Props {
  uid: string;
  thread: Thread;
  canComment: boolean;
  needsName: boolean;
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
  docFormat: DocumentFormat;
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
  ) => Promise<void>;
  onEditProposalRationale: (id: string, rationale: string | null) => Promise<void>;
}

export function InlineThreadCard({
  uid,
  thread,
  canComment,
  needsName,
  docSource,
  blockRanges,
  docFormat,
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
  onEditProposalRationale,
}: Props) {
  const composerRef = useRef<InlineComposerHandle>(null);
  const [busy, setBusy] = useState(false);

  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<{ before: string; after: string } | null>(null);
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

  const originalSource = useMemo(() => {
    if (!proposalThread) return '';
    return resolveProposalDiffBefore({ thread: proposalThread, docSource, blockRanges, docFormat });
  }, [proposalThread, docSource, blockRanges, docFormat]);

  const diffBefore = resolvedDiff?.before ?? originalSource;
  const diffAfter = resolvedDiff?.after ?? proposalThread?.proposal.proposed_text ?? '';

  const canAccept = proposal && thread.capabilities.accept;
  const canReject = proposal && thread.capabilities.reject;
  const canResolve = !proposal && !isResolved && thread.capabilities.resolve;
  const canReopen = !proposal && isResolved && thread.capabilities.reopen;

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
    if (status === 'accepted' && !proposalThread.proposal.source_snapshot) {
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
      return;
    }
    setResolvedDiff(null);
    setDiffOpen(true);
  }

  async function runWorkflow(
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) {
    setBusy(true);
    try {
      await onResolveThread(thread.id, kind, body, name);
    } finally {
      setBusy(false);
    }
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
          {proposalThread ? (
            <InlineProposalEntry
              thread={proposalThread}
              onEditRationale={onEditProposalRationale}
              onDeleteThread={onDeleteThread}
            />
          ) : (
            <InlineCommentRow
              node={thread.comments[0]}
              variant="opener"
              canQuote={canComment}
              onEdit={onEdit}
              onDelete={() => onDeleteThread(thread.id)}
              onQuote={canComment ? handleQuote : undefined}
            />
          )}

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
                      // `canRunAction` is false while submitting OR
                      // while the composer still needs a display name
                      // — disable the workflow buttons in both cases
                      // so they don't look clickable but silently no-op.
                      const disabled = !canRunAction || busy;
                      return (
                        <>
                          {canAccept && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-accept"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('accept', body, name))
                              }
                              disabled={disabled}
                            >
                              Accept
                            </button>
                          )}
                          {canReject && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-reject"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('reject', body, name))
                              }
                              disabled={disabled}
                            >
                              Reject
                            </button>
                          )}
                          {canResolve && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-resolve"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('resolve', body, name))
                              }
                              disabled={disabled}
                            >
                              Resolve
                            </button>
                          )}
                          {canReopen && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-ghost"
                              onClick={() =>
                                void runAction((body, name) => runWorkflow('reopen', body, name))
                              }
                              disabled={disabled}
                            >
                              Reopen
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
                    disabled={busy}
                  >
                    Accept
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-reject"
                    onClick={() => void runWorkflow('reject')}
                    disabled={busy}
                  >
                    Reject
                  </button>
                )}
                {canResolve && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-resolve"
                    onClick={() => void runWorkflow('resolve')}
                    disabled={busy}
                  >
                    Resolve
                  </button>
                )}
                {canReopen && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost"
                    onClick={() => void runWorkflow('reopen')}
                    disabled={busy}
                  >
                    Reopen
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
          before={diffBefore}
          after={diffAfter}
          actions={
            status === 'open' && (canAccept || canReject) ? (
              <>
                {canAccept && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-accept"
                    onClick={async () => {
                      await runWorkflow('accept');
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
                      await runWorkflow('reject');
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
