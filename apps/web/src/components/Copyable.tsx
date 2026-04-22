import { useRef, useState } from 'react';
import { ActionIcon as IconButton, Code, Tooltip } from '@mantine/core';
import { CheckIcon, CopyIcon } from '../icons.js';
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
  /** Shared UI size token for the code surface. */
  size?: '1' | '2' | '3';
}

const FONT_SIZE = {
  '1': 'xs',
  '2': 'sm',
  '3': 'md',
} as const;

const ACTION_SIZE = {
  '1': 'xs',
  '2': 'sm',
  '3': 'md',
} as const;

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
        <Code fz={FONT_SIZE[size]} className="copyable-text">{text}</Code>
        <Tooltip label={copied ? 'Copied!' : ariaLabel}>
          <IconButton
            type="button"
            size={ACTION_SIZE[size]}
            variant="subtle"
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
