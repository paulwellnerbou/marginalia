import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Dialog, Flex, IconButton, Text, TextArea, TextField } from '@radix-ui/themes';
import { PaperPlaneIcon } from '@radix-ui/react-icons';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat } from '../lib/api.js';
import type { ProposalTarget } from './SelectionToolbar.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ComposerHandle {
  insertText: (text: string) => void;
}

export interface ComposerFooterContext {
  hasDraft: boolean;
  canRunAction: boolean;
  submitting: boolean;
  submitAction: (
    action: (body?: string, name?: string) => Promise<void> | void,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Inline comment composer — used for new comments and thread replies
// ---------------------------------------------------------------------------

interface CommentComposerProps {
  mentionCandidates: string[];
  placeholder: string;
  needsName: boolean;
  rows?: number;
  onCancel?: () => void;
  footerActions?: ((context: ComposerFooterContext) => ReactNode) | undefined;
  onSubmit: (body: string, name?: string) => Promise<void> | void;
}

export const CommentComposer = forwardRef<ComposerHandle, CommentComposerProps>(
  function CommentComposer(
    { mentionCandidates, placeholder, needsName, rows = 3, onCancel, footerActions, onSubmit },
    ref,
  ) {
    const [value, setValue] = useState('');
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [caret, setCaret] = useState(0);
    const [activeMentionIndex, setActiveMentionIndex] = useState(0);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const body = value.trim();
    const displayName = name.trim();
    const hasDraft = body.length > 0;
    const canIdentify = !needsName || displayName.length > 0;
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

    const ready = hasDraft && canIdentify;
    const canRunAction = canIdentify && !submitting;

    async function send() {
      if (!ready) return;
      setSubmitting(true);
      try {
        await onSubmit(body, needsName ? displayName : undefined);
        setValue('');
        setCaret(0);
      } finally {
        setSubmitting(false);
      }
    }

    async function submitAction(action: (body?: string, name?: string) => Promise<void> | void) {
      if (!canRunAction) return;
      setSubmitting(true);
      try {
        await action(hasDraft ? body : undefined, needsName ? displayName : undefined);
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
        value.slice(0, activeMention.start) +
        mentionText +
        trailing +
        value.slice(activeMention.end);
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
          rows={rows}
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
            <Button
              variant="soft"
              color="gray"
              size="1"
              onClick={handleCancel}
              disabled={submitting}
            >
              Cancel
            </Button>
          )}
          {footerActions?.({ hasDraft, canRunAction, submitting, submitAction })}
          <IconButton size="1" variant="soft" onClick={send} disabled={!ready || submitting} aria-label="Post comment">
            <PaperPlaneIcon />
          </IconButton>
        </Flex>
      </Flex>
    );
  },
);

// ---------------------------------------------------------------------------
// Proposal dialog composer — used for new edit proposals
// ---------------------------------------------------------------------------

interface ProposalComposerProps {
  target: ProposalTarget | null;
  docSource: string;
  docFormat: DocumentFormat;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: (payload: {
    proposed_text: string;
    rationale?: string;
    display_name?: string;
  }) => Promise<void> | void;
}

export function ProposalComposer({
  target,
  docSource,
  docFormat,
  blockRanges,
  needsName,
  onCancel,
  onSubmit,
}: ProposalComposerProps) {
  const open = target !== null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <Dialog.Content size="3" maxWidth="720px">
        {target && (
          <ProposalComposerBody
            target={target}
            docSource={docSource}
            docFormat={docFormat}
            blockRanges={blockRanges}
            needsName={needsName}
            onCancel={onCancel}
            onSubmit={onSubmit}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ProposalComposerBody({
  target,
  docSource,
  docFormat,
  blockRanges,
  needsName,
  onCancel,
  onSubmit,
}: {
  target: ProposalTarget;
  docSource: string;
  docFormat: DocumentFormat;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: ProposalComposerProps['onSubmit'];
}) {
  const originalSource = useMemo(() => {
    const range = blockRanges.get(target.block_id);
    return range ? docSource.slice(range.start, range.end) : '';
  }, [docSource, blockRanges, target.block_id]);

  const [value, setValue] = useState(originalSource);
  const [rationale, setRationale] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValue(originalSource);
    setRationale('');
  }, [target.block_id, originalSource]);

  const changed = value !== originalSource && value.trim().length > 0;
  const ready = changed && (!needsName || name.trim().length > 0);

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      const payload: Parameters<ProposalComposerProps['onSubmit']>[0] = { proposed_text: value };
      if (rationale.trim()) payload.rationale = rationale.trim();
      if (needsName) payload.display_name = name.trim();
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }

  const formatLabel = docFormat === 'asciidoc' ? 'AsciiDoc' : 'Markdown';

  return (
    <>
      <Dialog.Title>Propose edit</Dialog.Title>
      <Dialog.Description size="2" color="gray" mb="3">
        Edit the {formatLabel} source of this block. Editors will review the diff before accepting.
      </Dialog.Description>

      <Flex direction="column" gap="3" className="edit-proposal-composer composer">
        <div className="composer-quote">
          "{target.block_text.slice(0, 240)}
          {target.block_text.length > 240 ? '…' : ''}"
        </div>

        {needsName && (
          <Flex direction="column" gap="1">
            <Text as="label" size="2" htmlFor="proposal-name">
              Your display name
            </Text>
            <TextField.Root
              id="proposal-name"
              className="composer-name-field"
              size="1"
              placeholder="Your display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </Flex>
        )}

        <Flex direction="column" gap="1">
          <Text as="label" size="2" htmlFor="proposal-text">
            Edited {formatLabel}
          </Text>
          <TextArea
            id="proposal-text"
            className="composer-body-field proposal-source-field"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            size="1"
            autoFocus={!needsName}
          />
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" size="2" htmlFor="proposal-rationale">
            Reason (optional)
          </Text>
          <TextArea
            id="proposal-rationale"
            className="composer-body-field"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why should this change be made?"
            rows={3}
            size="1"
          />
        </Flex>
      </Flex>

      <Flex gap="2" justify="end" mt="4">
        <Button variant="soft" color="gray" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={send} disabled={!ready || submitting}>
          {submitting ? 'Submitting…' : 'Submit proposal'}
        </Button>
      </Flex>
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
