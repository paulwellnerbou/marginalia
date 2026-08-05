import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { filterShortcodes, getActiveShortcode, type ShortcodeMatch } from './emojiShortcodes.js';

export interface InlineComposerHandle {
  /**
   * Append text to the draft. Focuses the textarea and parks the caret
   * after it unless `focus` is false — pass false when the composer has
   * just mounted and its own `autoFocus` owns the focus target.
   */
  insertText: (text: string, options?: { focus?: boolean }) => void;
  focus: () => void;
}

export interface InlineComposerLeftActionsContext {
  /** True when the textarea has a non-empty trimmed body. */
  hasDraft: boolean;
  /** True when a submit (post or workflow action) is in flight. */
  submitting: boolean;
  /**
   * False while a submit is in flight or while the composer still needs
   * a display name (`needsName=true` and the name input is empty).
   * Callers should use this to disable left-side action buttons —
   * `runAction` itself silently no-ops when `canRunAction` is false,
   * so a button rendered without honoring this flag would look
   * clickable but do nothing.
   */
  canRunAction: boolean;
  /**
   * Run an action that may optionally consume the current draft body /
   * display name. The composer mirrors the submitting state and clears
   * the textarea on success — actions that return `false` keep the
   * draft (e.g. a failed accept/reject), so the user can retry without
   * retyping. Returning void or `true` clears as before.
   * No-op when `canRunAction` is false.
   */
  runAction: (
    action: (body?: string, name?: string) => Promise<boolean | undefined> | boolean | undefined,
  ) => Promise<void>;
}

interface Props {
  placeholder: string;
  needsName: boolean;
  mentionCandidates?: string[];
  rows?: number;
  submitLabel?: string;
  showCancel?: boolean;
  /**
   * When true, the textarea (or display-name input, if present) takes
   * focus on mount. Off by default — every expanded thread card
   * renders a reply composer, and auto-focusing them all on page
   * mount would steal focus and scroll the viewport unpredictably.
   * Turn it on for the pending/new-comment composer or any composer
   * the user explicitly opened.
   */
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (body: string, name?: string) => Promise<void> | void;
  /** Rendered on the left of the action row, before Cancel/Submit. */
  leftActions?: ((ctx: InlineComposerLeftActionsContext) => ReactNode) | undefined;
}

export const InlineComposer = forwardRef<InlineComposerHandle, Props>(function InlineComposer(
  {
    placeholder,
    needsName,
    mentionCandidates = [],
    rows = 2,
    submitLabel = 'Post',
    showCancel = false,
    autoFocus = false,
    onCancel,
    onSubmit,
    leftActions,
  },
  ref,
) {
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  // Track which path is in flight so we don't flip the Reply/Post label
  // to `…` while a sibling left-action (Accept/Reject/Resolve/Reopen) is
  // running. Both paths still gate the same disabled checks.
  const [submitting, setSubmitting] = useState<'reply' | 'action' | false>(false);
  const [caret, setCaret] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeShortcodeIndex, setActiveShortcodeIndex] = useState(0);
  const [shortcodeDismissed, setShortcodeDismissed] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const mentionOptions = useMemo(() => buildMentionOptions(mentionCandidates), [mentionCandidates]);
  const activeMention = useMemo(() => getActiveMention(value, caret), [value, caret]);
  const filteredMentionOptions = useMemo(
    () =>
      activeMention && !mentionDismissed
        ? filterMentionOptions(mentionOptions, activeMention.query, 8)
        : [],
    [activeMention, mentionDismissed, mentionOptions],
  );

  // `:foo` emoji shortcode autocomplete. Mention takes priority when
  // both happen to be active so a single keystream can't drive two
  // overlapping menus — in practice they can't overlap (different
  // sigils + word-boundary requirement) but the precedence guard keeps
  // the keyboard handler unambiguous.
  const activeShortcode = useMemo(
    () => (activeMention ? null : getActiveShortcode(value, caret)),
    [activeMention, value, caret],
  );
  const filteredShortcodeOptions = useMemo<ShortcodeMatch[]>(
    () =>
      activeShortcode && !shortcodeDismissed ? filterShortcodes(activeShortcode.query, 8) : [],
    [activeShortcode, shortcodeDismissed],
  );

  useEffect(() => {
    if (activeMentionIndex < filteredMentionOptions.length) return;
    setActiveMentionIndex(0);
  }, [activeMentionIndex, filteredMentionOptions.length]);

  useEffect(() => {
    if (activeShortcodeIndex < filteredShortcodeOptions.length) return;
    setActiveShortcodeIndex(0);
  }, [activeShortcodeIndex, filteredShortcodeOptions.length]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const el = needsName ? nameRef.current : textRef.current;
      el?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, needsName]);

  useImperativeHandle(ref, () => ({
    insertText(text: string, options?: { focus?: boolean }) {
      setValue((prev) => {
        const sep =
          prev.length === 0 ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
        const next = `${prev}${sep}${text}\n\n`;
        setCaret(next.length);
        return next;
      });
      // Deferred: the textarea's DOM value only catches up after the
      // render that `setValue` triggers, and the caret has to land past it.
      window.setTimeout(() => {
        const el = textRef.current;
        if (!el) return;
        if (options?.focus !== false) el.focus({ preventScroll: true });
        const pos = el.value.length;
        el.setSelectionRange(pos, pos);
      }, 0);
    },
    focus() {
      textRef.current?.focus({ preventScroll: true });
    },
  }));

  const body = value.trim();
  const displayName = name.trim();
  const hasDraft = body.length > 0;
  const canIdentify = !needsName || displayName.length > 0;
  const isBusy = submitting !== false;
  const ready = hasDraft && canIdentify && !isBusy;
  const canRunAction = canIdentify && !isBusy;

  async function send() {
    if (!ready) return;
    setSubmitting('reply');
    try {
      await onSubmit(body, needsName ? displayName : undefined);
      setValue('');
      setCaret(0);
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(
    action: (body?: string, name?: string) => Promise<boolean | undefined> | boolean | undefined,
  ) {
    if (!canRunAction) return;
    setSubmitting('action');
    try {
      const ok = await action(hasDraft ? body : undefined, needsName ? displayName : undefined);
      // Actions that return `false` failed (and surfaced their own error);
      // keep the draft so the user can retry. `void` / `true` = success.
      if (ok !== false) {
        setValue('');
        setCaret(0);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setValue('');
    setCaret(0);
    onCancel?.();
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
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && activeMention) {
        e.preventDefault();
        const selected = filteredMentionOptions[activeMentionIndex] ?? filteredMentionOptions[0];
        if (selected) insertMention(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (filteredShortcodeOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveShortcodeIndex((prev) => (prev + 1) % filteredShortcodeOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveShortcodeIndex(
          (prev) => (prev - 1 + filteredShortcodeOptions.length) % filteredShortcodeOptions.length,
        );
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && activeShortcode) {
        e.preventDefault();
        const selected =
          filteredShortcodeOptions[activeShortcodeIndex] ?? filteredShortcodeOptions[0];
        if (selected) insertShortcode(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShortcodeDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (ready) void send();
    }
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (
      (filteredMentionOptions.length > 0 || filteredShortcodeOptions.length > 0) &&
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)
    ) {
      return;
    }
    updateCaret(e.currentTarget);
  }

  function updateCaret(target: HTMLTextAreaElement) {
    setCaret(target.selectionStart ?? target.value.length);
    setActiveMentionIndex(0);
    setActiveShortcodeIndex(0);
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
    setMentionDismissed(false);
    window.setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  function insertShortcode(match: ShortcodeMatch) {
    if (!activeShortcode) return;
    // Replace just the `:foo` token (start..end). The user may already
    // have typed a closing `:` past the caret — leave it, we don't
    // want to second-guess what's "after" the autocomplete trigger.
    const nextValue =
      value.slice(0, activeShortcode.start) + match.emoji + value.slice(activeShortcode.end);
    const nextCaret = activeShortcode.start + match.emoji.length;
    setValue(nextValue);
    setCaret(nextCaret);
    setActiveShortcodeIndex(0);
    setShortcodeDismissed(false);
    window.setTimeout(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  return (
    <div className="ic-composer">
      {needsName && (
        <input
          ref={nameRef}
          type="text"
          className="ic-composer-name"
          placeholder="Your display name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <textarea
        ref={textRef}
        className="ic-composer-body"
        placeholder={placeholder}
        rows={rows}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          updateCaret(e.target);
          setMentionDismissed(false);
          setShortcodeDismissed(false);
        }}
        onKeyDown={handleKey}
        onClick={(e) => updateCaret(e.currentTarget)}
        onKeyUp={handleKeyUp}
        onSelect={(e) => updateCaret(e.currentTarget)}
      />
      {activeMention && filteredMentionOptions.length > 0 && (
        <div className="ic-mention-menu">
          {filteredMentionOptions.map((option, index) => (
            <button
              key={option.toLowerCase()}
              type="button"
              className={`ic-mention-option ${index === activeMentionIndex ? 'active' : ''}`}
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
      {activeShortcode && filteredShortcodeOptions.length > 0 && (
        <div className="ic-mention-menu">
          {filteredShortcodeOptions.map((match, index) => (
            <button
              key={match.shortcode}
              type="button"
              className={`ic-mention-option ${index === activeShortcodeIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertShortcode(match);
              }}
            >
              <span className="ic-shortcode-emoji" aria-hidden="true">
                {match.emoji}
              </span>
              :{match.shortcode}:
            </button>
          ))}
        </div>
      )}
      <div className="ic-composer-actions">
        <span className="ic-composer-hint">⌘/Ctrl+Enter</span>
        {leftActions && (
          <div className="ic-composer-left-actions">
            {leftActions({ hasDraft, submitting: isBusy, canRunAction, runAction })}
          </div>
        )}
        {(showCancel || onCancel) && (
          <button
            type="button"
            className="ic-btn ic-btn-ghost"
            onClick={handleCancel}
            disabled={isBusy}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="ic-btn ic-btn-primary"
          disabled={!ready}
          onClick={() => void send()}
        >
          {/* Only flip the label while *this* button's submit is in flight —
              a sibling left-action being busy disables Reply but keeps the
              label, so two controls don't both look like they're loading. */}
          {submitting === 'reply' ? '…' : submitLabel}
        </button>
      </div>
    </div>
  );
});

export interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

export function buildMentionOptions(mentionCandidates: string[]): string[] {
  const deduped = new Map<string, string>();
  deduped.set('all', 'all');
  for (const candidate of mentionCandidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  }
  return Array.from(deduped.values());
}

export function filterMentionOptions(
  mentionOptions: string[],
  query: string,
  limit: number,
): string[] {
  const normalizedQuery = normalizeMentionQuery(query);
  if (!normalizedQuery) return mentionOptions.slice(0, limit);
  return mentionOptions
    .filter((option) => {
      const normalizedOption = option.toLowerCase();
      return (
        normalizedOption.startsWith(normalizedQuery) || normalizedOption.includes(normalizedQuery)
      );
    })
    .slice(0, limit);
}

export function getActiveMention(value: string, caret: number): ActiveMention | null {
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
