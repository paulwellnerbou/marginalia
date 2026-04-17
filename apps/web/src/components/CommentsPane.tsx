import { useMemo, useState } from 'react';
import { Badge, Button, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import { CheckCircledIcon } from '@radix-ui/react-icons';
import type { Comment, CommentAnchor } from '../lib/api.js';
import { CommentItem } from './CommentItem.js';

interface Props {
  comments: Comment[];
  /** New-comment draft captured from selection; non-null → composer is open */
  pendingAnchor: CommentAnchor | null;
  onCancelPending: () => void;
  isDocAdmin: boolean;
  /** Null if the viewer hasn't set a display name yet — Composer will ask. */
  displayName: string | null;
  onCreate: (payload: {
    anchor?: CommentAnchor;
    parent_id?: string;
    body: string;
    display_name?: string;
  }) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  /** Scroll the document pane to a block and flash it. */
  onScrollToAnchor: (blockId: string) => void;
}

interface AnchorGroup {
  top: Comment;
  replies: Comment[];
}

export function CommentsPane(props: Props) {
  const {
    comments,
    pendingAnchor,
    onCancelPending,
    isDocAdmin,
    displayName,
    onCreate,
    onEdit,
    onDelete,
    onResolve,
    onScrollToAnchor,
  } = props;

  const { active, orphans } = useMemo(() => groupByAnchor(comments), [comments]);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [expandedResolved, setExpandedResolved] = useState<Set<string>>(new Set());

  async function submitNew(body: string, name?: string) {
    if (!pendingAnchor) return;
    const payload: Parameters<typeof onCreate>[0] = { anchor: pendingAnchor, body };
    if (name !== undefined) payload.display_name = name;
    await onCreate(payload);
  }

  async function submitReply(parentId: string, body: string, name?: string) {
    const payload: Parameters<typeof onCreate>[0] = { parent_id: parentId, body };
    if (name !== undefined) payload.display_name = name;
    await onCreate(payload);
    setReplyingTo(null);
  }

  return (
    <div className="comments-pane">
      {pendingAnchor && (
        <div className="comment-composer">
          <div className="quote">“{pendingAnchor.quote}”</div>
          <Composer
            placeholder="Your comment…"
            needsName={!displayName}
            onCancel={onCancelPending}
            onSubmit={submitNew}
          />
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
              onResolve={onResolve}
              onScrollToAnchor={onScrollToAnchor}
              needsName={!displayName}
              expanded={expandedResolved.has(g.top.id)}
              onToggleExpanded={() =>
                setExpandedResolved((prev) => {
                  const next = new Set(prev);
                  if (next.has(g.top.id)) next.delete(g.top.id);
                  else next.add(g.top.id);
                  return next;
                })
              }
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
          onResolve={onResolve}
          onScrollToAnchor={onScrollToAnchor}
          needsName={!displayName}
          expanded={expandedResolved.has(g.top.id)}
          onToggleExpanded={() =>
            setExpandedResolved((prev) => {
              const next = new Set(prev);
              if (next.has(g.top.id)) next.delete(g.top.id);
              else next.add(g.top.id);
              return next;
            })
          }
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
  onResolve,
  onScrollToAnchor,
  needsName,
  expanded,
  onToggleExpanded,
}: {
  group: AnchorGroup;
  isDocAdmin: boolean;
  replyingTo: string | null;
  setReplyingTo: (v: string | null) => void;
  submitReply: (parentId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onScrollToAnchor: (blockId: string) => void;
  needsName: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const isResolved = group.top.resolved_at !== null;
  const showReplies = !isResolved || expanded;
  const anchorBlockId = group.top.anchor?.block_id ?? null;

  // Clicking the quote or the thread-jump button scrolls the document pane
  // to the commented block.
  const jump = anchorBlockId ? () => onScrollToAnchor(anchorBlockId) : undefined;

  return (
    <div className={`anchor-group ${isResolved ? 'resolved' : ''}`}>
      {group.top.anchor?.quote && (
        <button
          type="button"
          className="anchor-quote"
          title="Jump to this location in the document"
          onClick={jump}
        >
          <span className="jump-icon" aria-hidden>↗</span>“{group.top.anchor.quote}”
        </button>
      )}

      <Flex align="center" gap="2" className="thread-toolbar">
        {isResolved ? (
          <>
            <Badge color="green" variant="soft">
              <CheckCircledIcon />
              Resolved{group.top.resolved_by_name ? ` by ${group.top.resolved_by_name}` : ''}
            </Badge>
            {group.replies.length > 0 && (
              <Button size="1" variant="ghost" onClick={onToggleExpanded}>
                {expanded
                  ? 'Hide replies'
                  : `Show ${group.replies.length} repl${group.replies.length === 1 ? 'y' : 'ies'}`}
              </Button>
            )}
            <span className="spacer" />
            <Button size="1" variant="ghost" onClick={() => onResolve(group.top.id, false)}>
              Reopen
            </Button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <Button
              size="1"
              variant="ghost"
              color="green"
              onClick={() => onResolve(group.top.id, true)}
            >
              <CheckCircledIcon />
              Resolve thread
            </Button>
          </>
        )}
      </Flex>

      <CommentItem
        comment={group.top}
        isDocAdmin={isDocAdmin}
        onEdit={onEdit}
        onDelete={onDelete}
        onReply={isResolved ? undefined : (id) => setReplyingTo(id)}
      />
      {showReplies &&
        group.replies.map((r) => (
          <CommentItem
            key={r.id}
            comment={r}
            isDocAdmin={isDocAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      {replyingTo === group.top.id && !isResolved && (
        <div className="reply-composer">
          <Composer
            placeholder="Reply…"
            needsName={needsName}
            onCancel={() => setReplyingTo(null)}
            onSubmit={(body, name) => submitReply(group.top.id, body, name)}
          />
        </div>
      )}
    </div>
  );
}

function Composer({
  placeholder,
  needsName,
  onCancel,
  onSubmit,
}: {
  placeholder: string;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: (body: string, name?: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const ready = value.trim().length > 0 && (!needsName || name.trim().length > 0);

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim(), needsName ? name.trim() : undefined);
      setValue('');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ready && !submitting) void send();
    }
  }

  return (
    <Flex direction="column" gap="2" className="composer">
      {needsName && (
        <TextField.Root
          size="1"
          placeholder="Your display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
        />
      )}
      <TextArea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        rows={3}
        size="1"
        autoFocus={!needsName}
      />
      <Flex gap="2" align="center" justify="end">
        <Text size="1" color="gray" mr="auto">⌘/Ctrl+Enter to post</Text>
        <Button variant="ghost" size="1" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="1" onClick={send} disabled={!ready || submitting}>
          {submitting ? 'Posting…' : 'Post'}
        </Button>
      </Flex>
    </Flex>
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
