import { useEffect, useRef, useState } from 'react';
import { Flex, IconButton, Tooltip } from '@radix-ui/themes';
import { CheckIcon, Cross2Icon, TrashIcon } from '@radix-ui/react-icons';

interface Props {
  /** Label shown in the default state (e.g. "Delete"). */
  label: string;
  /** Label shown after the first click (e.g. "Confirm"). Defaults to "Confirm". */
  confirmLabel?: string;
  /** Radix size token for both buttons. */
  size?: '1' | '2' | '3';
  /** Auto-revert to the initial state if no second click arrives in this many ms. */
  timeoutMs?: number;
  /** Accessible label / tooltip content. */
  ariaLabel?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * Inline two-step confirmation in place of native `window.confirm`.
 * First click reveals a "Cancel / Confirm" pair; second click fires.
 * Auto-reverts after `timeoutMs` (default 4s).
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  size = '1',
  timeoutMs = 4000,
  ariaLabel,
  onConfirm,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), timeoutMs);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [armed, timeoutMs]);

  if (!armed) {
    return (
      <Tooltip content={label}>
        <IconButton
          size={size}
          variant="ghost"
          color="red"
          aria-label={ariaLabel ?? label}
          onClick={() => setArmed(true)}
        >
          <TrashIcon />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Flex gap="2" align="center" className="confirm-pair">
      <Tooltip content="Cancel delete">
        <IconButton
          size={size}
          variant="soft"
          color="gray"
          aria-label="Cancel delete"
          onClick={() => setArmed(false)}
        >
          <Cross2Icon />
        </IconButton>
      </Tooltip>
      <Tooltip content={confirmLabel}>
        <IconButton
          size={size}
          variant="soft"
          color="red"
          aria-label={confirmLabel}
          onClick={() => {
            setArmed(false);
            void onConfirm();
          }}
        >
          <CheckIcon />
        </IconButton>
      </Tooltip>
      {/* Keep `label`/`confirmLabel` props for callers, but render icon buttons here. */}
      <span hidden>{label}</span>
      <span hidden>{confirmLabel}</span>
    </Flex>
  );
}
