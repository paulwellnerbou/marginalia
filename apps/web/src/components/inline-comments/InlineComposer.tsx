import {
  type ReactNode,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

export interface InlineComposerHandle {
  insertText: (text: string) => void;
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
    action: (body?: string, name?: string) => Promise<boolean | void> | boolean | void,
  ) => Promise<void>;
}

interface Props {
  placeholder: string;
  needsName: boolean;
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
  const nameRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const el = needsName ? nameRef.current : textRef.current;
      el?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, needsName]);

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      setValue((prev) => {
        const sep =
          prev.length === 0 ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
        return `${prev}${sep}${text}\n\n`;
      });
      window.setTimeout(() => {
        const el = textRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
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
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(
    action: (body?: string, name?: string) => Promise<boolean | void> | boolean | void,
  ) {
    if (!canRunAction) return;
    setSubmitting('action');
    try {
      const ok = await action(hasDraft ? body : undefined, needsName ? displayName : undefined);
      // Actions that return `false` failed (and surfaced their own error);
      // keep the draft so the user can retry. `void` / `true` = success.
      if (ok !== false) setValue('');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setValue('');
    onCancel?.();
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (ready) void send();
    }
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
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
      />
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
