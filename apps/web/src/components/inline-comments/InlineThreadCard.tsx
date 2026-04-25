import type { BlockSourceRange } from '@marginalia/renderer';
import { useRef, useState } from 'react';
import type { Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';
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
  const [resolving, setResolving] = useState(false);

  const proposal = isProposal(thread);
  const status = proposal ? proposalStatus(thread) : null;
  const isResolved = thread.state === 'resolved';
  const isOrphan = thread.link_status === 'orphaned' && status !== 'accepted';
  const replyCount = thread.comments.length - 1;
  const replies = thread.comments.slice(1);

  function handleQuote(text: string) {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    composerRef.current?.insertText(quoted);
    composerRef.current?.focus();
  }

  async function runResolve(kind: 'resolve' | 'reopen') {
    setResolving(true);
    try {
      await onResolveThread(thread.id, kind);
    } finally {
      setResolving(false);
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

  return (
    <article className={cardClasses} data-comment-thread-id={thread.id} tabIndex={-1}>
      <header className="ic-card-header">
        <div className="ic-card-badges">
          {proposal && <span className="ic-badge ic-badge-proposal">Proposed change</span>}
          {proposal && status === 'accepted' && (
            <span className="ic-badge ic-badge-accepted">Accepted</span>
          )}
          {proposal && status === 'rejected' && (
            <span className="ic-badge ic-badge-rejected">Rejected</span>
          )}
          {isResolved && !proposal && <span className="ic-badge ic-badge-resolved">Resolved</span>}
          {isOrphan && <span className="ic-badge ic-badge-orphan">Orphaned</span>}
        </div>
        {thread.anchor.quote && (
          <button
            type="button"
            className="ic-card-anchor"
            title="Jump to this location in the document"
            onClick={onJump}
            disabled={!onJump}
          >
            <span aria-hidden>↗</span> "{truncate(thread.anchor.quote, 80)}"
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
          {proposal ? (
            <InlineProposalEntry
              uid={uid}
              thread={thread}
              docSource={docSource}
              blockRanges={blockRanges}
              onResolveThread={onResolveThread}
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

          {!proposal && !isResolved && thread.capabilities.resolve && (
            <div className="ic-card-workflow">
              <button
                type="button"
                className="ic-btn ic-btn-resolve"
                onClick={() => void runResolve('resolve')}
                disabled={resolving}
              >
                Resolve
              </button>
            </div>
          )}
          {!proposal && isResolved && thread.capabilities.reopen && (
            <div className="ic-card-workflow">
              <button
                type="button"
                className="ic-btn ic-btn-link"
                onClick={() => void runResolve('reopen')}
                disabled={resolving}
              >
                Reopen
              </button>
            </div>
          )}

          {canComment && (
            <InlineComposer
              ref={composerRef}
              placeholder={replyCount === 0 && !proposal ? 'Reply…' : 'Reply…'}
              needsName={needsName}
              rows={2}
              submitLabel="Reply"
              onSubmit={(body, name) => onReply(thread.id, body, name)}
            />
          )}
        </div>
      )}
    </article>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
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
