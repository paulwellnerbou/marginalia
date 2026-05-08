import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import { Code, IconButton, Tooltip } from '@radix-ui/themes';
import { useRef, useState } from 'react';
import { reportError } from '../lib/log.js';

interface Props {
  /** The value to display and copy to the clipboard. */
  text: string;
  /** If true, the copy icon sits in the upper-right corner so it doesn't
   *  collide with wrapped content. Defaults to false (icon at the right
   *  edge, vertically centered). */
  multiline?: boolean;
  /** Accessible label for the copy action. Defaults to "Copy". */
  ariaLabel?: string;
  /** Radix Code size. */
  size?: '1' | '2' | '3';
}

/**
 * A small, self-contained "copyable code block" with a subtle copy icon
 * and a check-mark confirmation animation on success. Replaces the big
 * "Copy X" buttons that used to live next to credentials.
 */
export function Copyable({ text, multiline = false, ariaLabel = 'Copy', size = '2' }: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      reportError('Copyable.copy', err);
    }
  }

  return (
    <div className={`copyable ${multiline ? 'copyable-multiline' : 'copyable-inline'}`}>
      <div className="copyable-surface">
        <Code size={size} className="copyable-text">
          {text}
        </Code>
        <Tooltip content={copied ? 'Copied!' : ariaLabel}>
          <IconButton
            type="button"
            size="1"
            variant="ghost"
            color={copied ? 'green' : 'gray'}
            aria-label={ariaLabel}
            className={`copyable-btn ${copied ? 'copyable-btn--copied' : ''}`}
            onClick={copy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      </div>
    </div>
  );
}
