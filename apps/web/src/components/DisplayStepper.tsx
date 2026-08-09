import { MinusIcon, PlusIcon, ResetIcon } from '@radix-ui/react-icons';
import { Flex, IconButton, Tooltip } from '@radix-ui/themes';
import type { KeyboardEvent } from 'react';
import { stepForKey, stepValue } from './displayStepperValue.js';

interface Props {
  value: number;
  min: number;
  max: number;
  /** One click, one arrow press. Off-grid values snap onto it. */
  step: number;
  /** Where the reset control lands. */
  defaultValue: number;
  ariaLabel: string;
  /** Rendered as the value — `72ch`, `120%`. */
  format: (value: number) => string;
  onCommit: (value: number) => void;
  /** Defaults to committing `defaultValue`. */
  onReset?: () => void;
}

/**
 * A display setting as `[-] 100% [+] [reset]`.
 *
 * Discrete steps rather than a slider: these settings re-lay-out the whole
 * document, and in paged mode that means re-fragmenting it into columns
 * from the start — a fraction of a second per step on a book-length
 * document. Dragging through that stalls badly enough that the drag stops
 * tracking the finger, so the setting could be impossible to move more
 * than a step or two on a tablet. A click is one relayout, and lands on a
 * round number rather than wherever the finger came to rest.
 */
export function DisplayStepper({
  value,
  min,
  max,
  step,
  defaultValue,
  ariaLabel,
  format,
  onCommit,
  onReset,
}: Props) {
  const range = { min, max, step };
  const noun = ariaLabel.toLowerCase();

  const commit = (next: number) => {
    if (next !== value) onCommit(next);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const next = stepForKey(event.key, value, range);
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <Flex align="center" gap="1">
      {/* Out of the tab order, per the spinbutton pattern: the value itself
          is the keyboard control, and three tab stops per setting would
          bury the rest of the menu. Pointer and screen reader still reach
          them. */}
      <IconButton
        size="1"
        variant="soft"
        color="gray"
        tabIndex={-1}
        aria-label={`Decrease ${noun}`}
        disabled={value <= min}
        onClick={() => commit(stepValue(value, -1, range))}
      >
        <MinusIcon />
      </IconButton>
      <span
        role="spinbutton"
        tabIndex={0}
        className="doc-stepper-value"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format(value)}
        onKeyDown={handleKeyDown}
      >
        {format(value)}
      </span>
      <IconButton
        size="1"
        variant="soft"
        color="gray"
        tabIndex={-1}
        aria-label={`Increase ${noun}`}
        disabled={value >= max}
        onClick={() => commit(stepValue(value, 1, range))}
      >
        <PlusIcon />
      </IconButton>
      <Tooltip content={`Reset to ${format(defaultValue)}`}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="doc-stepper-reset"
          aria-label={`Reset ${noun} to ${format(defaultValue)}`}
          disabled={value === defaultValue}
          onClick={onReset ?? (() => onCommit(defaultValue))}
        >
          <ResetIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}
