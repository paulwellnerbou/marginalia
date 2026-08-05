import { FileTextIcon, PilcrowIcon } from '@radix-ui/react-icons';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Comment, ProposalDiff, Thread } from '../../lib/api.js';
import { getEditProposalDiff, isProposal, proposalStatus } from '../../lib/api.js';
import { reportError } from '../../lib/log.js';
import { DiffDialog } from '../DiffDialog.js';
import { InlineCommentRow } from './InlineCommentRow.js';
import { InlineComposer, type InlineComposerHandle } from './InlineComposer.js';
import type { ThreadRefApi } from './threadRefs.js';

/**
 * The threads on the other end of this one's proposal link, resolved by
 * the list so the card doesn't need the whole thread set.
 */
export interface ThreadLinks {
  /** The comment thread this proposal answers, if it answers one. */
  answers: Thread | null;
  /** Proposals written to answer this comment thread, oldest first. */
  answeredBy: Thread[];
}

interface Props {
  uid: string;
  thread: Thread;
  links: ThreadLinks;
  /** Focus another thread; absent when the target has no anchor to scroll to. */
  onFocusLinked: (target: Thread) => void;
  /** Resolves thread ids mentioned in comment bodies into links. */
  threadRefs: ThreadRefApi;
  canComment: boolean;
  needsName: boolean;
  focused: boolean;
  flashPhase: 'a' | 'b' | null;
  collapsed: boolean;
  mentionCandidates: string[];
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
  onRepairThread: (id: string) => Promise<boolean>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
}

/**
 * A pointer to the thread on the other end of a proposal link.
 *
 * Jumping there goes through the anchor, so a target whose anchor was
 * lost (orphaned by an accepted edit) has nowhere to scroll to. Render
 * that case as plain text rather than a button that does nothing —
 * knowing the link exists is still worth showing, but a control that
 * silently ignores clicks is not.
 */
function ThreadLink({
  target,
  onFocus,
  title,
  children,
}: {
  target: Thread;
  onFocus: (target: Thread) => void;
  title: string;
  children: ReactNode;
}) {
  if (!target.anchor.block_id) {
    return (
      <span className="ic-card-link ic-card-link-static" title={`${title} (anchor lost)`}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" className="ic-card-link" onClick={() => onFocus(target)} title={title}>
      {children}
    </button>
  );
}

export function InlineThreadCard({
  uid,
  thread,
  links,
  onFocusLinked,
  threadRefs,
  canComment,
  needsName,
  focused,
  flashPhase,
  collapsed,
  mentionCandidates,
  onToggleCollapsed,
  onJump,
  onReply,
  onEdit,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onReact,
}: Props) {
  const composerRef = useRef<InlineComposerHandle>(null);
  // Track BOTH the kind and the render location that started the action.
  // The same proposal can render Accept/Reject in up to two places at
  // once (the underlying card + the open diff dialog); without `source`
  // a single click would put the spinner in both copies of the matching
  // button instead of only the one the user actually pressed.
  type ThreadWorkflowKind = 'accept' | 'reject' | 'resolve' | 'reopen';
  type WorkflowKind = ThreadWorkflowKind | 'repair';
  type WorkflowSource = 'header' | 'composer' | 'standalone' | 'dialog';
  const [busy, setBusy] = useState<{ kind: WorkflowKind; source: WorkflowSource } | null>(null);
  const isRunning = (kind: WorkflowKind, source: WorkflowSource) =>
    busy !== null && busy.kind === kind && busy.source === source;

  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<ProposalDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const proposal = isProposal(thread);
  const status = proposal ? proposalStatus(thread) : null;
  const isResolved = thread.state === 'resolved';
  const isOrphan = thread.link_status === 'orphaned' && status !== 'accepted';
  const isConflict = proposal && thread.link_status === 'conflict' && status !== 'accepted';
  const replies = thread.comments.slice(1);

  const proposalThread = proposal
    ? (thread as Thread & { proposal: NonNullable<Thread['proposal']> })
    : null;

  const canAccept = proposal && thread.capabilities.accept;
  const canReject = proposal && thread.capabilities.reject;
  const canRepair = proposal && thread.capabilities.repair;
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
        react: base.capabilities.react,
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
    kind: ThreadWorkflowKind,
    source: WorkflowSource,
    body?: string,
    name?: string,
  ): Promise<boolean> {
    // Returning false on the re-entry guard (rather than the in-flight
    // promise) prevents a second click on a still-busy button from
    // resolving immediately and tricking callers into post-success steps
    // (e.g. closing the diff dialog before the original request finishes).
    if (busy) return false;
    setBusy({ kind, source });
    try {
      return await onResolveThread(thread.id, kind, body, name);
    } finally {
      setBusy(null);
    }
  }

  async function runRepair(): Promise<void> {
    if (busy) return;
    setBusy({ kind: 'repair', source: 'header' });
    try {
      if (await onRepairThread(thread.id)) {
        setResolvedDiff(null);
      }
    } finally {
      setBusy(null);
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
    isConflict ? 'ic-card-conflict' : '',
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
                <span className="ic-badge-text">Proposed change</span>
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
            {isConflict && <span className="ic-badge ic-badge-conflict">Conflict</span>}
            {isOrphan && <span className="ic-badge ic-badge-orphan">Orphaned</span>}
          </div>
          {proposal && (
            <div className="ic-card-header-actions">
              <button
                type="button"
                className="ic-btn ic-btn-ghost ic-card-show-diff"
                onClick={() => void showDiff()}
                disabled={loadingDiff}
                title="Show the proposed text change"
              >
                {loadingDiff ? 'Loading…' : 'Show diff'}
              </button>
              {canRepair && (
                <button
                  type="button"
                  className="ic-btn ic-btn-ghost"
                  onClick={() => void runRepair()}
                  disabled={busy !== null && !isRunning('repair', 'header')}
                  aria-busy={isRunning('repair', 'header')}
                  aria-label="Repair anchor"
                  title="Use the proposal branch diff to re-anchor this thread"
                >
                  {workflowContent('Repair anchor', isRunning('repair', 'header'))}
                </button>
              )}
            </div>
          )}
        </div>
        {diffError && <span className="ic-error">{diffError}</span>}
        {links.answers && (
          <ThreadLink
            target={links.answers}
            onFocus={onFocusLinked}
            title={`Written to answer ${links.answers.comments[0].author.display_name}'s comment`}
          >
            Answers: {formatAnchorQuote(links.answers.anchor.quote, 48) || 'a comment'}
          </ThreadLink>
        )}
        {links.answeredBy.length > 0 && (
          <div className="ic-card-answers">
            {links.answeredBy.map((target, index) => (
              <ThreadLink
                key={target.id}
                target={target}
                onFocus={onFocusLinked}
                title={`${target.comments[0].author.display_name} proposed a change for this comment`}
              >
                See proposed change{links.answeredBy.length > 1 ? ` ${index + 1}` : ''}
                {proposalStatus(target) !== 'open' ? ` (${proposalStatus(target)})` : ''}
              </ThreadLink>
            ))}
          </div>
        )}
        {onJump && (
          <button
            type="button"
            className="ic-card-anchor"
            title="Jump to this location in the document"
            onClick={onJump}
          >
            <span aria-hidden>↗</span> {anchorQuote ? `"${anchorQuote}"` : 'Jump to anchor'}
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
            threadRefs={threadRefs}
            onEdit={onEdit}
            onDelete={() => onDeleteThread(thread.id)}
            onQuote={canComment ? handleQuote : undefined}
            onReact={onReact}
          />

          {replies.map((reply) => (
            <InlineCommentRow
              key={reply.id}
              node={reply}
              variant="reply"
              canQuote={canComment}
              threadRefs={threadRefs}
              onEdit={onEdit}
              onDelete={onDeleteNode}
              onQuote={canComment ? handleQuote : undefined}
              onReact={onReact}
            />
          ))}

          {canComment ? (
            <InlineComposer
              ref={composerRef}
              placeholder="Reply…"
              needsName={needsName}
              mentionCandidates={mentionCandidates}
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
                      const isDisabledFor = (kind: WorkflowKind) =>
                        busy === null ? !canRunAction : !isRunning(kind, 'composer');
                      return (
                        <>
                          {canAccept && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-accept"
                              onClick={() =>
                                void runAction((body, name) =>
                                  runWorkflow('accept', 'composer', body, name),
                                )
                              }
                              disabled={isDisabledFor('accept')}
                              aria-busy={isRunning('accept', 'composer')}
                              aria-label="Accept"
                            >
                              {workflowContent('Accept', isRunning('accept', 'composer'))}
                            </button>
                          )}
                          {canReject && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-reject"
                              onClick={() =>
                                void runAction((body, name) =>
                                  runWorkflow('reject', 'composer', body, name),
                                )
                              }
                              disabled={isDisabledFor('reject')}
                              aria-busy={isRunning('reject', 'composer')}
                              aria-label="Reject"
                            >
                              {workflowContent('Reject', isRunning('reject', 'composer'))}
                            </button>
                          )}
                          {canResolve && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-resolve"
                              onClick={() =>
                                void runAction((body, name) =>
                                  runWorkflow('resolve', 'composer', body, name),
                                )
                              }
                              disabled={isDisabledFor('resolve')}
                              aria-busy={isRunning('resolve', 'composer')}
                              aria-label="Resolve"
                            >
                              {workflowContent('Resolve', isRunning('resolve', 'composer'))}
                            </button>
                          )}
                          {canReopen && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-ghost"
                              onClick={() =>
                                void runAction((body, name) =>
                                  runWorkflow('reopen', 'composer', body, name),
                                )
                              }
                              disabled={isDisabledFor('reopen')}
                              aria-busy={isRunning('reopen', 'composer')}
                              aria-label="Reopen"
                            >
                              {workflowContent('Reopen', isRunning('reopen', 'composer'))}
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
                    onClick={() => void runWorkflow('accept', 'standalone')}
                    disabled={busy !== null && !isRunning('accept', 'standalone')}
                    aria-busy={isRunning('accept', 'standalone')}
                    aria-label="Accept"
                  >
                    {workflowContent('Accept', isRunning('accept', 'standalone'))}
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-reject"
                    onClick={() => void runWorkflow('reject', 'standalone')}
                    disabled={busy !== null && !isRunning('reject', 'standalone')}
                    aria-busy={isRunning('reject', 'standalone')}
                    aria-label="Reject"
                  >
                    {workflowContent('Reject', isRunning('reject', 'standalone'))}
                  </button>
                )}
                {canResolve && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-resolve"
                    onClick={() => void runWorkflow('resolve', 'standalone')}
                    disabled={busy !== null && !isRunning('resolve', 'standalone')}
                    aria-busy={isRunning('resolve', 'standalone')}
                    aria-label="Resolve"
                  >
                    {workflowContent('Resolve', isRunning('resolve', 'standalone'))}
                  </button>
                )}
                {canReopen && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost"
                    onClick={() => void runWorkflow('reopen', 'standalone')}
                    disabled={busy !== null && !isRunning('reopen', 'standalone')}
                    aria-busy={isRunning('reopen', 'standalone')}
                    aria-label="Reopen"
                  >
                    {workflowContent('Reopen', isRunning('reopen', 'standalone'))}
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
          before={resolvedDiff?.original?.before ?? resolvedDiff?.before ?? ''}
          after={resolvedDiff?.original?.after ?? resolvedDiff?.after ?? ''}
          contextLines={3}
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
                      if (await runWorkflow('accept', 'dialog')) setDiffOpen(false);
                    }}
                    disabled={busy !== null && !isRunning('accept', 'dialog')}
                    aria-busy={isRunning('accept', 'dialog')}
                    aria-label="Accept"
                  >
                    {workflowContent('Accept', isRunning('accept', 'dialog'))}
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-reject"
                    onClick={async () => {
                      if (await runWorkflow('reject', 'dialog')) setDiffOpen(false);
                    }}
                    disabled={busy !== null && !isRunning('reject', 'dialog')}
                    aria-busy={isRunning('reject', 'dialog')}
                    aria-label="Reject"
                  >
                    {workflowContent('Reject', isRunning('reject', 'dialog'))}
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
