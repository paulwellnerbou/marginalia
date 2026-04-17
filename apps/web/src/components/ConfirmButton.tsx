import { useEffect, useRef, useState } from 'react';
import { Button, Flex } from '@radix-ui/themes';

interface Props {
  /** Label shown in the default state (e.g. "Delete"). */
  label: string;
  /** Label shown after the first click (e.g. "Confirm"). Defaults to "Confirm". */
  confirmLabel?: string;
  /** Radix size token for both buttons. */
  size?: '1' | '2' | '3';
  /** Auto-revert to the initial state if no second click arrives in this many ms. */
  timeoutMs?: number;
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
      <Button size={size} variant="ghost" color="red" onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  return (
    <Flex gap="2" align="center">
      <Button size={size} variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
      <Button
        size={size}
        color="red"
        onClick={() => {
          setArmed(false);
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </Flex>
  );
}
