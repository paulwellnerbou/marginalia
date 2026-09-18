import type { Ref, RefObject } from 'react';

/** Opens a toolbar dialog from somewhere other than its own button. */
export interface FoldedDialogHandle {
  open(): void;
}

export interface FoldableDialogProps {
  ref?: Ref<FoldedDialogHandle> | undefined;
  /**
   * The overflow button the dialog's own button is folded into. While
   * set, the dialog renders no button and returns focus here on close.
   */
  foldedInto?: RefObject<HTMLElement | null> | undefined;
}

/**
 * `onCloseAutoFocus` for a dialog opened with no trigger on screen. Radix
 * hands focus back to the trigger, and with none mounted it falls to the
 * body, far from where the keyboard user was.
 */
export function returnFocusTo(
  target: RefObject<HTMLElement | null> | undefined,
): ((event: Event) => void) | undefined {
  if (!target) return undefined;
  return (event) => {
    event.preventDefault();
    target.current?.focus({ preventScroll: true });
  };
}
