import { useEffect, useMemo, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { Badge, Button, Flex, IconButton, Text, TextArea, TextField } from '@radix-ui/themes';
import { CheckCircledIcon, ChevronDownIcon, ChevronRightIcon, PaperPlaneIcon } from '@radix-ui/react-icons';
import type { Comment, CommentAnchor } from '../lib/api.js';
import { CommentItem } from './CommentItem.js';

export interface ComposerHandle {
  insertText: (text: string) => void;
}

interface Props {
  comments: Comment[];
  mentionCandidates: string[];
  canComment: boolean;
  /** New-comment draft captured from selection; non-null → composer is open */
  pendingAnchor: CommentAnchor | null;
  focusedThread: { threadId: string; nonce: number } | null;
  onCancelPending: () => void;
  isDocAdmin: boolean;
  viewerClientId: string;
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
    mentionCandidates,
    canComment,
    pendingAnchor,
    focusedThread,
    onCancelPending,
    isDocAdmin,
    viewerClientId,
    displayName,
    onCreate,
    onEdit,
    onDelete,
    onResolve,
    onScrollToAnchor,
  } = props;

  const { active, orphans } = useMemo(() => groupByAnchor(comments), [comments]);
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(new Set());
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHandledFocusNonce = useRef<number | null>(null);

  useEffect(() => {
    if (!focusedThread) return;
    if (lastHandledFocusNonce.current === focusedThread.nonce) return;

    if (collapsedThreads.has(focusedThread.threadId)) {
      setCollapsedThreads((prev) => {
        if (!prev.has(focusedThread.threadId)) return prev;
        const next = new Set(prev);
        next.delete(focusedThread.threadId);
        return next;
      });
      return;
    }

    const selector = `[data-comment-thread-id="${CSS.escape(focusedThread.threadId)}"]`;
    const threadEl = rootRef.current?.querySelector<HTMLElement>(selector);
    if (!threadEl) return;

    lastHandledFocusNonce.current = focusedThread.nonce;
    setFocusedThreadId(focusedThread.threadId);
    const frame = window.requestAnimationFrame(() => {
      threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timeout = window.setTimeout(() => {
      setFocusedThreadId((current) =>
        current === focusedThread.threadId ? null : current,
      );
    }, 1800);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [active, collapsedThreads, focusedThread, orphans]);

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
  }

  return (
    <div ref={rootRef} className="comments-pane">
      {canComment && pendingAnchor && (
        <div className="comment-composer">
          <div className="quote">“{pendingAnchor.quote}”</div>
          <Composer
            mentionCandidates={mentionCandidates}
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
              viewerClientId={viewerClientId}
              mentionCandidates={mentionCandidates}
              canComment={canComment}
              submitReply={submitReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onResolve={onResolve}
              onScrollToAnchor={onScrollToAnchor}
              needsName={!displayName}
              threadFocused={focusedThreadId === g.top.id}
              collapsed={collapsedThreads.has(g.top.id)}
              onToggleCollapsed={() =>
                setCollapsedThreads((prev) => {
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
          {canComment
            ? 'Select text in the document to comment.'
            : 'You have read-only access to this document.'}
        </div>
      )}

      {active.map((g) => (
        <AnchorGroupView
          key={g.top.id}
          group={g}
          isDocAdmin={isDocAdmin}
          viewerClientId={viewerClientId}
          mentionCandidates={mentionCandidates}
          canComment={canComment}
          submitReply={submitReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onResolve={onResolve}
          onScrollToAnchor={onScrollToAnchor}
          needsName={!displayName}
          threadFocused={focusedThreadId === g.top.id}
          collapsed={collapsedThreads.has(g.top.id)}
          onToggleCollapsed={() =>
            setCollapsedThreads((prev) => {
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
  viewerClientId,
  mentionCandidates,
  canComment,
  submitReply,
  onEdit,
  onDelete,
  onResolve,
  onScrollToAnchor,
  needsName,
  threadFocused,
  collapsed,
  onToggleCollapsed,
}: {
  group: AnchorGroup;
  isDocAdmin: boolean;
  viewerClientId: string;
  mentionCandidates: string[];
  canComment: boolean;
  submitReply: (parentId: string, body: string, name?: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onScrollToAnchor: (blockId: string) => void;
  needsName: boolean;
  threadFocused: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const isResolved = group.top.resolved_at !== null;
  const canResolve = isDocAdmin || group.top.author.client_id === viewerClientId;
  const showThread = !collapsed;
  const anchorBlockId = group.top.anchor?.block_id ?? null;

  const composerRef = useRef<ComposerHandle>(null);

  const handleQuote = (text: string) => {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    composerRef.current?.insertText(quoted);
  };

  // Clicking the quote or the thread-jump button scrolls the document pane
  // to the commented block.
  const jump = anchorBlockId ? () => onScrollToAnchor(anchorBlockId) : undefined;

  return (
    <div
      className={`anchor-group ${isResolved ? 'resolved' : ''} ${threadFocused ? 'thread-focused' : ''}`}
      data-comment-thread-id={group.top.id}
    >
      {group.top.anchor?.quote && (
        <button
          type="button"
          className="anchor-quote"
          title="Jump to this location in the document"
          onClick={jump}
        >
          <span className="jump-icon" aria-hidden>
            ↗
          </span>
          “{group.top.anchor.quote}”
        </button>
      )}

      <Flex align="center" gap="2" className="thread-toolbar">
        <Button
          size="1"
          variant="ghost"
          color="gray"
          className="thread-collapse-button"
          aria-expanded={showThread}
          onClick={onToggleCollapsed}
        >
          {showThread ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {showThread ? 'Collapse thread' : 'Expand thread'}
        </Button>
        <Text size="1" color="gray">
          {group.replies.length === 0
            ? 'No replies'
            : `${group.replies.length} repl${group.replies.length === 1 ? 'y' : 'ies'}`}
        </Text>
        <span className="spacer" />
        {isResolved ? (
          <>
            <Badge color="green" variant="soft">
              <CheckCircledIcon />
              Resolved{group.top.resolved_by_name ? ` by ${group.top.resolved_by_name}` : ''}
            </Badge>
            {canResolve && (
              <Button
                size="1"
                variant="soft"
                color="gray"
                onClick={() => onResolve(group.top.id, false)}
              >
                Reopen
              </Button>
            )}
          </>
        ) : canResolve ? (
          <>
            <Button
              size="1"
              variant="soft"
              color="green"
              className="thread-resolve-button"
              onClick={() => onResolve(group.top.id, true)}
            >
              Resolve thread
            </Button>
          </>
        ) : null}
      </Flex>

      {showThread && (
        <>
          <CommentItem
            comment={group.top}
            isDocAdmin={isDocAdmin}
            onEdit={onEdit}
            onDelete={onDelete}
            onQuote={canComment ? handleQuote : undefined}
          />
          {group.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              isDocAdmin={isDocAdmin}
              onEdit={onEdit}
              onDelete={onDelete}
              onQuote={canComment ? handleQuote : undefined}
            />
          ))}
          {canComment && !isResolved && (
            <div className="reply-composer">
              <Composer
                ref={composerRef}
                mentionCandidates={mentionCandidates}
                placeholder="Reply…"
                needsName={needsName}
                onSubmit={(body, name) => submitReply(group.top.id, body, name)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const Composer = forwardRef<
  ComposerHandle,
  {
    mentionCandidates: string[];
    placeholder: string;
    needsName: boolean;
    onCancel?: () => void;
    onSubmit: (body: string, name?: string) => Promise<void> | void;
  }
>(({ mentionCandidates, placeholder, needsName, onCancel, onSubmit }, ref) => {
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [caret, setCaret] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const hasDraft = value.trim().length > 0;
  const pendingCursorRef = useRef<number | null>(null);
  const mentionOptions = useMemo(() => {
    const deduped = new Map<string, string>();
    deduped.set('all', 'all');
    for (const candidate of mentionCandidates) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, trimmed);
    }
    return Array.from(deduped.values());
  }, [mentionCandidates]);
  const activeMention = useMemo(() => getActiveMention(value, caret), [value, caret]);
  const filteredMentionOptions = useMemo(() => {
    if (!activeMention) return [];
    const query = normalizeMentionQuery(activeMention.query);
    if (!query) return mentionOptions.slice(0, 8);
    return mentionOptions
      .filter((option) => {
        const normalized = option.toLowerCase();
        return normalized.startsWith(query) || normalized.includes(query);
      })
      .slice(0, 8);
  }, [activeMention, mentionOptions]);

  useEffect(() => {
    if (activeMentionIndex < filteredMentionOptions.length) return;
    setActiveMentionIndex(0);
  }, [activeMentionIndex, filteredMentionOptions.length]);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      setValue((prev) => {
        const prefix = prev
          ? prev + (prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n')
          : '';
        const next = `${prefix}${text}\n\n`;
        pendingCursorRef.current = next.length;
        return next;
      });
      setTimeout(() => {
        const el = textRef.current;
        if (!el) return;
        el.focus();
        const pos = pendingCursorRef.current ?? el.value.length;
        el.setSelectionRange(pos, pos);
        setCaret(pos);
        pendingCursorRef.current = null;
      }, 0);
    },
  }));

  const ready = value.trim().length > 0 && (!needsName || name.trim().length > 0);

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim(), needsName ? name.trim() : undefined);
      setValue('');
      setCaret(0);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setValue('');
    setCaret(0);
    if (onCancel) onCancel();
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (filteredMentionOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMentionIndex((prev) => (prev + 1) % filteredMentionOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMentionIndex(
          (prev) => (prev - 1 + filteredMentionOptions.length) % filteredMentionOptions.length,
        );
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && activeMention) {
        e.preventDefault();
        const selected = filteredMentionOptions[activeMentionIndex] ?? filteredMentionOptions[0];
        if (selected) insertMention(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCaret(-1);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (ready && !submitting) void send();
    }
  }

  function updateCaret(target: HTMLTextAreaElement) {
    setCaret(target.selectionStart ?? target.value.length);
    setActiveMentionIndex(0);
  }

  function insertMention(rawName: string) {
    if (!activeMention) return;
    const mentionText = `@${rawName}`;
    const nextChar = value[activeMention.end] ?? '';
    const trailing = nextChar && /\s/.test(nextChar) ? '' : ' ';
    const nextValue =
      value.slice(0, activeMention.start) + mentionText + trailing + value.slice(activeMention.end);
    const nextCaret = activeMention.start + mentionText.length + trailing.length;
    setValue(nextValue);
    setCaret(nextCaret);
    setActiveMentionIndex(0);
    window.setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  return (
    <Flex direction="column" gap="2" className="composer">
      {needsName && (
        <TextField.Root
          className="composer-name-field"
          size="1"
          placeholder="Your display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
        />
      )}
      <TextArea
        className="composer-body-field"
        ref={textRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          updateCaret(e.target);
        }}
        onKeyDown={handleKey}
        onClick={(e) => updateCaret(e.currentTarget)}
        onKeyUp={(e) => updateCaret(e.currentTarget)}
        onSelect={(e) => updateCaret(e.currentTarget)}
        placeholder={placeholder}
        rows={3}
        size="1"
        autoFocus={!needsName}
      />
      {activeMention && filteredMentionOptions.length > 0 && (
        <div className="mention-menu" aria-label="Mention suggestions">
          {filteredMentionOptions.map((option, index) => (
            <button
              key={option.toLowerCase()}
              type="button"
              className={`mention-option ${index === activeMentionIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(option);
              }}
            >
              @{option}
            </button>
          ))}
        </div>
      )}
      <Flex gap="2" align="center" justify="end" className="comment-composer-actions">
        <Text size="1" color="gray">
          Markdown supported · ⌘/Ctrl+Enter to post
        </Text>
        {(onCancel || hasDraft) && (
          <Button variant="soft" color="gray" size="1" onClick={handleCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <IconButton size="1" variant="soft" onClick={send} disabled={!ready || submitting}>
          <PaperPlaneIcon />
        </IconButton>
      </Flex>
    </Flex>
  );
});

interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

function getActiveMention(value: string, caret: number): ActiveMention | null {
  if (caret < 0) return null;
  const uptoCaret = value.slice(0, caret);
  const at = uptoCaret.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at === 0 ? '' : (uptoCaret[at - 1] ?? '');
  if (/[0-9A-Za-z_]/.test(prev)) return null;
  const query = uptoCaret.slice(at + 1);
  if (query.includes('\n')) return null;
  if (/[.,!?;:()[\]{}<>]/.test(query)) return null;
  return { start: at, end: caret, query };
}

function normalizeMentionQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
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
