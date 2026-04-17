import { useMemo, useState } from 'react';
import type { Comment, CommentAnchor } from '../lib/api.js';
import { CommentItem } from './CommentItem.js';

interface Props {
  comments: Comment[];
  /** New-comment draft captured from selection; non-null → composer is open */
  pendingAnchor: CommentAnchor | null;
  onCancelPending: () => void;
  isDocAdmin: boolean;
  onCreate: (payload: { anchor?: CommentAnchor; parent_id?: string; body: string }) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

interface AnchorGroup {
  top: Comment;
  replies: Comment[];
}

export function CommentsPane(props: Props) {
  const { comments, pendingAnchor, onCancelPending, isDocAdmin, onCreate, onEdit, onDelete } = props;

  const { active, orphans } = useMemo(() => groupByAnchor(comments), [comments]);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  async function submitNew(body: string) {
    if (!pendingAnchor) return;
    await onCreate({ anchor: pendingAnchor, body });
  }

  async function submitReply(parentId: string, body: string) {
    await onCreate({ parent_id: parentId, body });
    setReplyingTo(null);
  }

  return (
    <div className="comments-pane">
      {pendingAnchor && (
        <div className="comment-composer">
          <div className="quote">“{pendingAnchor.quote}”</div>
          <Composer placeholder="Your comment…" onCancel={onCancelPending} onSubmit={submitNew} />
        </div>
      )}

      {orphans.length > 0 && (
        <section className="orphans">
          <h4 className="subtle">Orphaned comments</h4>
          <p className="subtle small">
            These comments could not be matched to the current document.
          </p>
          {orphans.map((g) => (
            <AnchorGroupView
              key={g.top.id}
              group={g}
              isDocAdmin={isDocAdmin}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              submitReply={submitReply}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </section>
      )}

      {active.length === 0 && !pendingAnchor && orphans.length === 0 && (
        <div className="comments-empty subtle">
          Select text in the document to comment.
        </div>
      )}

      {active.map((g) => (
        <AnchorGroupView
          key={g.top.id}
          group={g}
          isDocAdmin={isDocAdmin}
          replyingTo={replyingTo}
          setReplyingTo={setReplyingTo}
          submitReply={submitReply}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function AnchorGroupView({
  group,
  isDocAdmin,
  replyingTo,
  setReplyingTo,
  submitReply,
  onEdit,
  onDelete,
}: {
  group: AnchorGroup;
  isDocAdmin: boolean;
  replyingTo: string | null;
  setReplyingTo: (v: string | null) => void;
  submitReply: (parentId: string, body: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div className="anchor-group">
      {group.top.anchor?.quote && (
        <blockquote className="anchor-quote">“{group.top.anchor.quote}”</blockquote>
      )}
      <CommentItem
        comment={group.top}
        isDocAdmin={isDocAdmin}
        onEdit={onEdit}
        onDelete={onDelete}
        onReply={(id) => setReplyingTo(id)}
      />
      {group.replies.map((r) => (
        <CommentItem
          key={r.id}
          comment={r}
          isDocAdmin={isDocAdmin}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
      {replyingTo === group.top.id && (
        <div className="reply-composer">
          <Composer
            placeholder="Reply…"
            onCancel={() => setReplyingTo(null)}
            onSubmit={(v) => submitReply(group.top.id, v)}
          />
        </div>
      )}
    </div>
  );
}

function Composer({
  placeholder,
  onCancel,
  onSubmit,
}: {
  placeholder: string;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function send() {
    const body = value.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      await onSubmit(body);
      setValue('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="composer">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={3}
        autoFocus
      />
      <div className="comment-actions">
        <button className="link" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="primary small" onClick={send} disabled={!value.trim() || submitting}>
          {submitting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}

function groupByAnchor(comments: Comment[]): { active: AnchorGroup[]; orphans: AnchorGroup[] } {
  const tops = new Map<string, AnchorGroup>();
  const replies: Comment[] = [];
  for (const c of comments) {
    if (c.parent_id) replies.push(c);
    else tops.set(c.id, { top: c, replies: [] });
  }
  for (const r of replies) {
    const parent = r.parent_id ? tops.get(r.parent_id) : undefined;
    if (parent) parent.replies.push(r);
  }
  const active: AnchorGroup[] = [];
  const orphans: AnchorGroup[] = [];
  for (const g of tops.values()) {
    if (g.top.status === 'orphaned') orphans.push(g);
    else active.push(g);
  }
  active.sort((a, b) => a.top.created_at - b.top.created_at);
  orphans.sort((a, b) => a.top.created_at - b.top.created_at);
  return { active, orphans };
}
