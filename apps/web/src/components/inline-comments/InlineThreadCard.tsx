import {
  BookmarkFilledIcon,
  BookmarkIcon,
  ChatBubbleIcon,
  CheckIcon,
  ClipboardCopyIcon,
  FileTextIcon,
  Pencil1Icon,
  PilcrowIcon,
} from '@radix-ui/react-icons';
import { Tooltip } from '@radix-ui/themes';
import { EyeOff } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Comment, ProposalConflict, ProposalDiff, Thread } from '../../lib/api.js';
import {
  getEditProposalConflict,
  getEditProposalDiff,
  isProposal,
  proposalStatus,
} from '../../lib/api.js';
import { apiErrorMessage } from '../../lib/apiErrorMessage.js';
import { reportError } from '../../lib/log.js';
import { ConflictDialog } from '../ConflictDialog.js';
import { DiffDialog } from '../DiffDialog.js';
import { useBookmarkControls } from './bookmarkedThreads.js';
import { InlineCommentRow } from './InlineCommentRow.js';
import { InlineComposer, type InlineComposerHandle } from './InlineComposer.js';
import type { ThreadActionResult } from './inlineUtils.js';
import {
  proposalDiffNeedsRefresh,
  readCachedProposalDiff,
  writeCachedProposalDiff,
} from './proposalDiffCache.js';
import type { ThreadRefApi } from './threadRefs.js';

/**
 * The threads on the other end of this one's proposal link, resolved by
 * the list so the card doesn't need the whole thread set.
 */
export interface ThreadLinks {
  /**
   * The comment threads this proposal answers, oldest first. The card
   * this one is nested in is filtered out by the caller — it is the
   * card wrapped around this one, not a place to link to.
   */
  answers: Thread[];
  /** Proposals written to answer this comment thread, oldest first. */
  answeredBy: Thread[];
}

interface Props {
  uid: string;
  thread: Thread;
  links: ThreadLinks;
  /**
   * This card renders inside the card of one thread its proposal
   * answers. Styling only — the link back to that thread is filtered
   * out of `links.answers` by the caller.
   */
  nested?: boolean;
  /**
   * Cards for the proposals answering this thread, rendered inside
   * this card after the replies. Threads rendered here are filtered
   * out of `links.answeredBy` by the caller.
   */
  nestedCards?: ReactNode[] | undefined;
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
  onSetHidden: (id: string, hidden: boolean) => Promise<void>;
  onDeleteNode: (id: string) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onResolveThread: (
    id: string,
    kind: 'resolve' | 'reopen' | 'accept' | 'reject',
    body?: string,
    name?: string,
  ) => Promise<ThreadActionResult>;
  onRepairThread: (id: string) => Promise<ThreadActionResult>;
  /**
   * Settle a conflicted proposal against the current document. Omitting
   * `resolvedText` asks the server for the merge it can make unaided.
   */
  onResolveConflict: (
    id: string,
    payload: { resolvedText?: string; comment?: string },
  ) => Promise<ThreadActionResult>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  /** Open a paragraph proposal linked to this plain comment thread. */
  onCreateProposal?: ((thread: Thread) => void) | undefined;
  /** Open the edit-proposal dialog for this thread; absent hides the button. */
  onEditProposal?: ((thread: Thread) => void) | undefined;
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
  nested = false,
  nestedCards,
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
  onSetHidden,
  onDeleteNode,
  onDeleteThread,
  onResolveThread,
  onRepairThread,
  onResolveConflict,
  onReact,
  onCreateProposal,
  onEditProposal,
}: Props) {
  const composerRef = useRef<InlineComposerHandle>(null);
  // Null when the card renders outside a document layout — then no toggle.
  const bookmarks = useBookmarkControls();
  const bookmarked = bookmarks?.isBookmarked(thread.id) ?? false;
  // The reply composer stays closed until asked for — one textarea per
  // expanded thread crowds the column out of the reading space.
  const [replyOpen, setReplyOpen] = useState(false);
  // A quote requested while the composer was closed: it can only be
  // inserted once the composer exists, so park it for the open effect.
  const pendingQuote = useRef<string | null>(null);
  // Closing unmounts whatever had focus (textarea, Cancel), which would
  // drop the keyboard user back to the document body.
  const replyButtonRef = useRef<HTMLButtonElement>(null);
  const restoreReplyFocus = useRef(false);
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
  // Why the last accept/reject/resolve/repair from this card failed.
  // The toast says the same thing but expires and doesn't name a thread;
  // this keeps the reason attached to the proposal it belongs to.
  const [actionError, setActionError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [resolvedDiff, setResolvedDiff] = useState<ProposalDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflict, setConflict] = useState<ProposalConflict | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [loadingConflict, setLoadingConflict] = useState(false);
  const [conflictActionError, setConflictActionError] = useState<string | null>(null);
  const [applyingResolution, setApplyingResolution] = useState(false);

  const proposal = isProposal(thread);
  const status = proposal ? proposalStatus(thread) : null;

  // An in-place content update to an open proposal (ours via the edit dialog, or another
  // client's arriving through a thread refresh) makes any cached diff
  // stale. Dropping the cache is enough: the fetch effect below refills
  // it while the dialog is open, so an open dialog re-renders the
  // revised change in place instead of snapping shut.
  //
  // Closed proposal payloads deliberately replace proposed_text with null.
  // Keep the existing diff across that lifecycle transition: acceptance
  // has succeeded and the dialog is about to close, so clearing it would
  // trigger a pointless historical-diff refetch and visible flicker.
  //
  // Dropped during render rather than from an effect, same as the reset
  // in ThreadComposer: an effect would commit one frame carrying the
  // superseded diff, showing the author the version they just replaced.
  const currentProposedText = thread.proposal?.proposed_text ?? null;
  const [trackedProposedText, setTrackedProposedText] = useState(currentProposedText);
  if (trackedProposedText !== currentProposedText) {
    setTrackedProposedText(currentProposedText);
    if (status && proposalDiffNeedsRefresh(status, trackedProposedText, currentProposedText)) {
      setResolvedDiff(null);
    }
  }
  const [idCopied, setIdCopied] = useState(false);
  const idCopyTimer = useRef<number | null>(null);

  // Clean up the copy-confirmation timer if the component unmounts while it's pending.
  useEffect(() => {
    return () => {
      if (idCopyTimer.current !== null) window.clearTimeout(idCopyTimer.current);
    };
  }, []);

  async function copyThreadId() {
    try {
      await navigator.clipboard.writeText(thread.id);
      setIdCopied(true);
      if (idCopyTimer.current !== null) window.clearTimeout(idCopyTimer.current);
      idCopyTimer.current = window.setTimeout(() => setIdCopied(false), 1500);
    } catch (err) {
      reportError('InlineThreadCard.copyThreadId', err, { threadId: thread.id });
    }
  }

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
  // Offer the resolver where a conflict is known to exist: pinned on the
  // thread by a failed accept, or reported by a diff the viewer opened.
  // Showing it on every proposal would put a repair control on the
  // overwhelming majority that need none.
  const canResolveConflict =
    proposal &&
    thread.capabilities.resolve_conflict &&
    (isConflict || resolvedDiff?.mergeable === 'conflict');
  const canResolve = !proposal && !isResolved && thread.capabilities.resolve;
  const canReopen = !proposal && isResolved && thread.capabilities.reopen;
  const canCreateProposal =
    !proposal &&
    !isResolved &&
    canComment &&
    thread.anchor.block_id !== null &&
    onCreateProposal !== undefined;
  // proposed_text is null when the branch tip is unreadable — nothing
  // to prefill an editor with, so no button either.
  const canUpdate =
    proposal &&
    thread.capabilities.update &&
    onEditProposal !== undefined &&
    proposalThread?.proposal.proposed_text != null;

  // Once a proposal leaves the open state, freeze edits: an accepted
  // proposal's rationale may already be quoted in a history entry (for
  // a fast-forward accept it's literally in the commit message — see
  // GitStore.createProposalBranch — though a 3-way-merge accept doesn't
  // carry it there), and a rejected one has no undo. Deletes follow the
  // server capability (admin-only once accepted); the history entry
  // keeps its attribution even after the thread is deleted.
  const openerNode: Comment = useMemo(() => {
    if (!proposal) return thread.comments[0];
    const base = thread.comments[0];
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        edit: base.capabilities.edit && status === 'open',
      },
    };
  }, [thread.comments, proposal, status]);
  const rootHidden = openerNode.hidden === true;

  function handleQuote(text: string) {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    if (!replyOpen) {
      pendingQuote.current = quoted;
      setReplyOpen(true);
      return;
    }
    composerRef.current?.insertText(quoted);
    composerRef.current?.focus();
  }

  function closeReply() {
    restoreReplyFocus.current = true;
    setReplyOpen(false);
  }

  useEffect(() => {
    if (!replyOpen) {
      if (!restoreReplyFocus.current) return;
      restoreReplyFocus.current = false;
      replyButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    const quoted = pendingQuote.current;
    if (!quoted) return;
    pendingQuote.current = null;
    // The freshly mounted composer autofocuses the display-name input
    // while a name is still required, and nothing can be posted until
    // that is filled — inserting the quote must not race it for focus.
    composerRef.current?.insertText(quoted, { focus: !needsName });
  }, [replyOpen, needsName]);

  // Fetch whenever the dialog is open without a diff for the current
  // text — the initial open, and every cache drop above while it stays
  // open. Errors don't loop: the effect re-runs only when the dialog
  // reopens or the text changes again.
  const threadId = thread.id;
  useEffect(() => {
    if (!diffOpen || !proposal || resolvedDiff !== null) return;
    // Windowing destroys cards that scroll out of view, taking their
    // diff state with them, so re-opening one used to re-fetch the whole
    // payload. The cache outlives the card; it validates against the
    // proposal's current text, so an edited proposal still re-reads.
    const cached = status
      ? readCachedProposalDiff(uid, threadId, status, currentProposedText)
      : null;
    if (cached) {
      setResolvedDiff(cached);
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    setDiffError(null);
    getEditProposalDiff(uid, threadId)
      .then((diff) => {
        writeCachedProposalDiff(uid, threadId, currentProposedText, diff);
        if (!cancelled) setResolvedDiff(diff);
      })
      .catch((err) => {
        reportError('InlineThreadCard.getEditProposalDiff', err, { uid, threadId });
        if (!cancelled) setDiffError('Could not load diff');
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });
    return () => {
      cancelled = true;
    };
  }, [diffOpen, proposal, resolvedDiff, uid, threadId, status, currentProposedText]);

  // Same shape as the diff fetch above, and refilled the same way: the
  // opener drops the cached conflict, so every open re-reads where the
  // proposal stands rather than resolving against a stale three-way.
  useEffect(() => {
    if (!conflictOpen || !proposal || conflict !== null) return;
    let cancelled = false;
    setLoadingConflict(true);
    setConflictError(null);
    getEditProposalConflict(uid, threadId)
      .then((next) => {
        if (!cancelled) setConflict(next);
      })
      .catch((err) => {
        reportError('InlineThreadCard.getEditProposalConflict', err, { uid, threadId });
        if (!cancelled) setConflictError(apiErrorMessage(err, 'Could not load the conflict'));
      })
      .finally(() => {
        if (!cancelled) setLoadingConflict(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conflictOpen, proposal, conflict, uid, threadId]);

  function openConflict() {
    setConflict(null);
    setConflictError(null);
    setConflictActionError(null);
    setConflictOpen(true);
  }

  async function applyResolution(payload: {
    resolvedText?: string;
    comment?: string;
  }): Promise<boolean> {
    if (applyingResolution) return false;
    setApplyingResolution(true);
    try {
      const result = await onResolveConflict(thread.id, payload);
      setConflictActionError(result.ok ? null : result.message);
      if (result.ok) {
        // The proposal now sits on current main, so the cached diff and
        // three-way both describe a state that no longer exists.
        setResolvedDiff(null);
        setConflict(null);
        setActionError(null);
      }
      return result.ok;
    } finally {
      setApplyingResolution(false);
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
      const result = await onResolveThread(thread.id, kind, body, name);
      setActionError(result.ok ? null : result.message);
      return result.ok;
    } finally {
      setBusy(null);
    }
  }

  async function runRepair(): Promise<void> {
    if (busy) return;
    setBusy({ kind: 'repair', source: 'header' });
    try {
      const result = await onRepairThread(thread.id);
      setActionError(result.ok ? null : result.message);
      if (result.ok) setResolvedDiff(null);
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
    nested ? 'ic-card-nested' : '',
    focused ? 'ic-card-focused' : '',
    flashPhase ? `ic-card-flash-${flashPhase}` : '',
    isResolved ? 'ic-card-resolved' : '',
    proposal ? 'ic-card-proposal' : 'ic-card-comment',
    proposal && status ? `ic-card-proposal-${status}` : '',
    isOrphan ? 'ic-card-orphaned' : '',
    isConflict ? 'ic-card-conflict' : '',
    rootHidden ? 'ic-card-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const nestedCount = nestedCards?.length ?? 0;
  const summary = proposal
    ? statusLabel(thread, status)
    : `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}${
        nestedCount > 0 ? ` · ${nestedCount} proposal${nestedCount === 1 ? '' : 's'}` : ''
      }`;
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
            {rootHidden && (
              <Tooltip content="Only visible to you. Replies are hidden with the root comment.">
                <span className="ic-badge ic-badge-hidden">
                  <EyeOff className="ic-badge-icon" strokeWidth={2.25} aria-hidden="true" />
                  Hidden thread
                </span>
              </Tooltip>
            )}
            {isConflict && <span className="ic-badge ic-badge-conflict">Conflict</span>}
            {isOrphan && <span className="ic-badge ic-badge-orphan">Orphaned</span>}
          </div>
          {proposal && (
            <div className="ic-card-header-actions">
              <button
                type="button"
                className="ic-btn ic-btn-ghost ic-card-show-diff"
                onClick={() => setDiffOpen(true)}
                title="Show the proposed text change"
              >
                Show diff
              </button>
              {canResolveConflict && (
                <button
                  type="button"
                  className="ic-btn ic-btn-ghost ic-btn-resolve-conflict"
                  onClick={openConflict}
                  title="Settle this proposal against the current text"
                >
                  Resolve conflict
                </button>
              )}
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
        {/* No live-region role: the toast for this same failure is already
            assertive, and a second one here would announce it twice. This
            copy is persistent context to navigate back to. */}
        {actionError && <span className="ic-error">{actionError}</span>}
        {links.answers.map((target) => (
          <ThreadLink
            key={target.id}
            target={target}
            onFocus={onFocusLinked}
            title={`Written to answer ${target.comments[0].author.display_name}'s comment`}
          >
            Answers: {formatAnchorQuote(target.anchor.quote, 48) || 'a comment'}
          </ThreadLink>
        ))}
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
        <div className="ic-card-anchor-row">
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
            className="ic-icon-btn ic-card-copy-id"
            onClick={() => void copyThreadId()}
            title={
              idCopied ? 'Thread id copied!' : 'Copy thread id — what an agent takes as thread_id'
            }
            aria-label={idCopied ? 'Thread id copied!' : 'Copy thread id'}
          >
            {idCopied ? <CheckIcon /> : <ClipboardCopyIcon />}
          </button>
          {bookmarks && (
            <button
              type="button"
              className={`ic-icon-btn ic-card-bookmark${bookmarked ? ' ic-card-bookmark-on' : ''}`}
              aria-pressed={bookmarked}
              onClick={() => bookmarks.toggle(thread.id)}
              title={bookmarked ? 'Remove bookmark' : 'Bookmark this thread'}
              aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this thread'}
            >
              {bookmarked ? <BookmarkFilledIcon /> : <BookmarkIcon />}
            </button>
          )}
        </div>
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
            onSetHidden={onSetHidden}
            onDelete={() => onDeleteThread(thread.id)}
            onQuote={canComment ? handleQuote : undefined}
            onReact={onReact}
          />

          {replies.map((reply) => (
            <InlineCommentRow
              key={reply.id}
              node={reply}
              variant="reply"
              hiddenByRoot={rootHidden && reply.hidden !== true}
              canQuote={canComment}
              threadRefs={threadRefs}
              onEdit={onEdit}
              onSetHidden={onSetHidden}
              onDelete={onDeleteNode}
              onQuote={canComment ? handleQuote : undefined}
              onReact={onReact}
            />
          ))}

          {nestedCount > 0 && <div className="ic-card-nested-list">{nestedCards}</div>}

          {canComment && replyOpen ? (
            <InlineComposer
              ref={composerRef}
              placeholder="Reply…"
              needsName={needsName}
              mentionCandidates={mentionCandidates}
              rows={2}
              submitLabel="Reply"
              showCancel
              autoFocus
              onCancel={closeReply}
              onSubmit={async (body, name) => {
                await onReply(thread.id, body, name);
                closeReply();
              }}
              leftActions={
                canAccept || canReject || canResolve || canReopen || canCreateProposal
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
                          {canCreateProposal && (
                            <button
                              type="button"
                              className="ic-btn ic-btn-ghost"
                              onClick={() => onCreateProposal?.(thread)}
                            >
                              Create edit proposal
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
            (canComment ||
              canAccept ||
              canReject ||
              canResolve ||
              canReopen ||
              canCreateProposal) && (
              <div className="ic-card-actions">
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
                {canCreateProposal && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost"
                    onClick={() => onCreateProposal?.(thread)}
                  >
                    Create edit proposal
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
                {canComment && (
                  <button
                    ref={replyButtonRef}
                    type="button"
                    className="ic-btn ic-btn-primary ic-card-reply-open"
                    onClick={() => setReplyOpen(true)}
                    title="Write a reply"
                  >
                    <ChatBubbleIcon aria-hidden="true" />
                    Reply
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
          startLine={(resolvedDiff?.original?.line_offset ?? 0) + 1}
          loading={loadingDiff}
          error={diffError}
          actionError={actionError}
          replyComposer={
            canComment ? (
              <InlineComposer
                placeholder="Add a comment to this thread…"
                needsName={needsName}
                mentionCandidates={mentionCandidates}
                rows={3}
                submitLabel="Comment"
                onSubmit={(body, name) => onReply(thread.id, body, name)}
              />
            ) : undefined
          }
          actions={
            status === 'open' && (canAccept || canReject || canUpdate || canResolveConflict) ? (
              <>
                {canResolveConflict && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost ic-btn-resolve-conflict"
                    onClick={() => {
                      setDiffOpen(false);
                      openConflict();
                    }}
                    title="Settle this proposal against the current text"
                  >
                    Resolve conflict
                  </button>
                )}
                {canUpdate && (
                  <button
                    type="button"
                    className="ic-btn ic-btn-ghost"
                    onClick={() => onEditProposal?.(thread)}
                    disabled={loadingDiff}
                    title="Revise the proposed text — with an optional comment on what changed"
                  >
                    <Pencil1Icon aria-hidden="true" />
                    Edit
                  </button>
                )}
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

      {proposal && (
        <ConflictDialog
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          conflict={conflict}
          loading={loadingConflict}
          error={conflictError}
          actionError={conflictActionError}
          applying={applyingResolution}
          onApply={applyResolution}
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
