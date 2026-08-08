import { Slider, Text } from '@radix-ui/themes';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** The committed value. The thumb follows the drag from here. */
  value: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  className?: string;
  /** Rendered next to the slider — `72ch`, `120%`. */
  format: (value: number) => string;
  onCommit: (value: number) => void;
}

/**
 * A display-setting slider that only commits on release.
 *
 * Reading width and text size both re-lay-out the whole document, and in
 * paged mode that means re-fragmenting it into columns from the start —
 * a fraction of a second per step on a book-length document. Applied per
 * drag tick that stalls the UI badly enough that the drag itself stops
 * tracking the finger, which is why the setting can be impossible to move
 * more than a step or two on a tablet. The number under the thumb still
 * follows the drag, so there is feedback the whole way.
 *
 * Draft state lives here rather than in the document layout so that
 * feedback costs a re-render of two elements, not of every comment card
 * on the page.
 */
export function DisplaySlider({
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  className,
  format,
  onCommit,
}: Props) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;

  // The element carrying `role="slider"` is the thumb, and Radix keeps it
  // out of reach — props on the root land on a wrapper the screen reader
  // never announces, leaving the control unnamed.
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector('[role="slider"]')?.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  return (
    <>
      <Slider
        ref={rootRef}
        size="1"
        className={className}
        min={min}
        max={max}
        step={step}
        value={[shown]}
        onValueChange={(next) => setDraft(next[0] ?? shown)}
        onValueCommit={(next) => {
          const committed = next[0] ?? shown;
          setDraft(null);
          onCommit(committed);
        }}
      />
      <Text size="1" color="gray" style={{ minWidth: '4ch', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {format(shown)}
      </Text>
    </>
  );
}
