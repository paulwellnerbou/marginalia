import { CheckIcon, Cross2Icon, TrashIcon } from '@radix-ui/react-icons';
import { Flex, IconButton, Tooltip } from '@radix-ui/themes';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  /** Keep a hidden slot reserved for the future cancel button. */
  reserveWidth?: boolean;
  /** Notify parent when the button enters or leaves confirmation mode. */
  onArmedChange?: (armed: boolean) => void;
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
  reserveWidth = true,
  onArmedChange,
  onConfirm,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  // Notify the parent in the SAME render batch as the state change so
  // sibling UI gated on `armed` doesn't flash on-screen for a frame
  // before it hears about it (a useEffect-driven notification runs
  // after paint).
  const setArmedAndNotify = useCallback(
    (next: boolean) => {
      setArmed(next);
      onArmedChange?.(next);
    },
    [onArmedChange],
  );

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmedAndNotify(false), timeoutMs);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [armed, timeoutMs, setArmedAndNotify]);

  if (!armed) {
    const trigger = (
      <Tooltip content={label}>
        <IconButton
          size={size}
          variant="soft"
          color="red"
          aria-label={ariaLabel ?? label}
          onClick={() => setArmedAndNotify(true)}
        >
          <TrashIcon />
        </IconButton>
      </Tooltip>
    );

    if (!reserveWidth) return trigger;

    return (
      <Flex gap="2" align="center" className="confirm-pair">
        <IconButton
          size={size}
          variant="soft"
          color="gray"
          aria-hidden="true"
          tabIndex={-1}
          className="confirm-pair-placeholder"
        >
          <Cross2Icon />
        </IconButton>
        {trigger}
      </Flex>
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
          onClick={() => setArmedAndNotify(false)}
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
            setArmedAndNotify(false);
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
