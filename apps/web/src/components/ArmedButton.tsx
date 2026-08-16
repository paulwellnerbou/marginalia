import { Button, Flex } from '@radix-ui/themes';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Two-step confirm for actions whose consequence has to be spelled out.
 * The sibling `ConfirmButton` is an icon-only trash affordance; these
 * actions destroy something a trash can doesn't describe (a keyring, a
 * document), so each state says in words what the next click does.
 *
 * Auto-disarms after 4s so a dialog left open doesn't keep a loaded
 * delete button under the cursor.
 */
export function ArmedButton({
  label,
  confirmLabel,
  color,
  icon,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  color: 'amber' | 'red';
  icon: ReactNode;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 4000);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [armed]);

  useEffect(() => {
    if (disabled && armed) setArmed(false);
  }, [disabled, armed]);

  if (!armed) {
    return (
      <Button variant="soft" color={color} disabled={disabled} onClick={() => setArmed(true)}>
        {icon} {label}
      </Button>
    );
  }

  return (
    <Flex gap="2">
      <Button variant="soft" color="gray" onClick={() => setArmed(false)}>
        Cancel
      </Button>
      <Button
        variant="solid"
        color={color}
        disabled={disabled}
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
