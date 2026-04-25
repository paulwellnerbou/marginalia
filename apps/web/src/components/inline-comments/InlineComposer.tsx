import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

export interface InlineComposerHandle {
  insertText: (text: string) => void;
  focus: () => void;
}

interface Props {
  placeholder: string;
  needsName: boolean;
  rows?: number;
  submitLabel?: string;
  showCancel?: boolean;
  onCancel?: () => void;
  onSubmit: (body: string, name?: string) => Promise<void> | void;
}

export const InlineComposer = forwardRef<InlineComposerHandle, Props>(function InlineComposer(
  {
    placeholder,
    needsName,
    rows = 2,
    submitLabel = 'Post',
    showCancel = false,
    onCancel,
    onSubmit,
  },
  ref,
) {
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

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
        el.focus();
        const pos = el.value.length;
        el.setSelectionRange(pos, pos);
      }, 0);
    },
    focus() {
      textRef.current?.focus();
    },
  }));

  const body = value.trim();
  const ready = body.length > 0 && (!needsName || name.trim().length > 0) && !submitting;

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onSubmit(body, needsName ? name.trim() : undefined);
      setValue('');
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
          type="text"
          className="ic-composer-name"
          placeholder="Your display name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          autoFocus
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
        autoFocus={!needsName}
      />
      <div className="ic-composer-actions">
        <span className="ic-composer-hint">⌘/Ctrl+Enter</span>
        {(showCancel || onCancel) && (
          <button
            type="button"
            className="ic-btn ic-btn-ghost"
            onClick={handleCancel}
            disabled={submitting}
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
          {submitting ? '…' : submitLabel}
        </button>
      </div>
    </div>
  );
});
