import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button, Flex, IconButton, Text, TextArea, TextField } from '@radix-ui/themes';
import { PaperPlaneIcon } from '@radix-ui/react-icons';

export interface ComposerHandle {
  insertText: (text: string) => void;
}

interface Props {
  mentionCandidates: string[];
  placeholder: string;
  needsName: boolean;
  rows?: number;
  onCancel?: () => void;
  onSubmit: (body: string, name?: string) => Promise<void> | void;
}

export const CommentComposer = forwardRef<ComposerHandle, Props>(function CommentComposer(
  { mentionCandidates, placeholder, needsName, rows = 3, onCancel, onSubmit },
  ref,
) {
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
